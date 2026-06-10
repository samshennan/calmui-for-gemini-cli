import * as vscode from 'vscode';
import { runDiagnostics, showDiagnosticsNotification } from './diagnostics';
import { ChatPanelProvider } from './providers/ChatPanelProvider';
import { GeminiProcess } from './process/GeminiProcess';
import { GeminiSessionManager } from './process/GeminiSessionManager';
import type { GeminiTransport } from './process/GeminiTransport';

let geminiProcess: GeminiTransport | undefined;
let sessionManager: GeminiSessionManager | undefined;

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('CalmUI for Gemini CLI');

  const config = vscode.workspace.getConfiguration('calmui');
  const useAcp = config.get<boolean>('useAcp', true);
  if (useAcp) {
    sessionManager = new GeminiSessionManager(outputChannel);
    context.subscriptions.push(sessionManager);
  } else {
    geminiProcess = new GeminiProcess(outputChannel);
    context.subscriptions.push(geminiProcess); // primary cleanup path (D-10)
  }

  const provider = new ChatPanelProvider(
    context,
    context.extensionUri,
    geminiProcess ?? sessionManager!.process,
    outputChannel,
    sessionManager,
    async (options?: { notify?: boolean }) => {
      // Phase 39 W2: thread the live ACP `promptCapabilities` cache into the
      // diagnostics probe so `search-grounding` can react to the most recent
      // handshake. Stream-json mode (`sessionManager` undefined) → `null`.
      const capabilities = sessionManager?.process.getPromptCapabilities() ?? null;
      const report = await runDiagnostics(outputChannel, context, capabilities);
      if (options?.notify !== false) {
        await showDiagnosticsNotification(report);
      }
      return report;
    },
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'calmui.chatView',
      provider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('calmui.focusChat', () => {
      vscode.commands.executeCommand('calmui.chatView.focus');
    }),
    vscode.commands.registerCommand('calmui.runDiagnostics', async () => {
      // Phase 39 W2: include live capabilities for the `search-grounding` probe.
      const capabilities = sessionManager?.process.getPromptCapabilities() ?? null;
      const report = await runDiagnostics(outputChannel, context, capabilities);
      await showDiagnosticsNotification(report);
      return report;
    }),
    vscode.commands.registerCommand('calmui.openMemory', () => {
      provider.openMemoryStudio();
      vscode.commands.executeCommand('calmui.chatView.focus');
    }),
  );

  const geminiPath = config.get<string>('geminiPath', 'gemini');
  outputChannel.appendLine(`CalmUI activated. Gemini path: ${geminiPath}. Transport: ${useAcp ? 'ACP' : 'stream-json'}`);
}

export function deactivate() {
  // Synchronous fallback per D-10 — VS Code may not await async deactivate
  if (geminiProcess) {
    geminiProcess.dispose();
  }
  if (sessionManager) {
    sessionManager.dispose();
  }
}
