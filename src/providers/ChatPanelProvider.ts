import * as crypto from 'crypto';

import * as vscode from 'vscode';
import { runGcloudCommand } from '../gcloud';
import { discoverGeminiExtensions } from '../extensionManager';
import { createInitProposal, discoverMemoryState, getProjectMemoryPath } from '../memory/memoryStudio';
import { discoverGeminiMcpServers, getMcpServerSignature, inspectMcpServers, mergeMcpServers } from '../mcpInspector';
import type { AcpMcpServer } from '../process/GeminiProcessAcp';
import type { GeminiSendOptions, GeminiTransport } from '../process/GeminiTransport';
import type { GeminiSessionManager, HealthState, RecoveryState, SessionHandle } from '../process/GeminiSessionManager';
import { buildMarkdownExport } from './exportMarkdown';
import { createTokenGuard, isTokenCurrent } from './generationToken';
import {
  DEFAULT_MODEL_OPTIONS,
  DEFAULT_SLASH_COMMANDS,
} from '../shared/messages';
import type {
  WebviewMessage,
  ExtensionMessage,
  AttachmentChip,
  ChatMessage,
  ChatState,
  ChatSession,
  ChatSessionSummary,
  CheckpointState,
  GcloudStatus,
  ChangedFile,
  DiagnosticsReport,
  GeminiExtensionReport,
  ImageAttachment,
  MemoryInitProposal,
  MemoryState,
  SearchMode,
} from '../shared/messages';
import {
  getAvailableCommands,
  getAvailableModels,
  getAssistantContent,
  getInitInfo,
  getErrorEvent,
  getPermissionRequest,
  getResultUsage,
  getThinkingContent,
  getToolActivity,
  getUserContent,
} from '../shared/parsers';

const SESSIONS_KEY = 'calmui.sessions';
const DIAGNOSTICS_KEY = 'calmui.diagnosticsReport';
const MCP_INSPECTOR_KEY = 'calmui.mcpInspectorReport';
const EXTENSIONS_KEY = 'calmui.extensionReport';
const MEMORY_STATE_KEY = 'calmui.memoryState';
const CHECKPOINT_STATE_KEY = 'calmui.checkpointState';
const MAX_SESSIONS = 50;
const MEMORY_DIFF_SCHEME = 'calmui-memory';

interface EditorFileContext {
  uri: string;
  path: string;
  languageId: string;
  cursor: { line: number; character: number };
  selection: string;
  text?: string;
}

interface EditorContextSnapshot {
  workspace: string | null;
  capturedAt: string;
  activeFile: EditorFileContext | null;
  visibleFiles: EditorFileContext[];
}

class MemoryDiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly _entries = new Map<string, string>();
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  set(uri: vscode.Uri, content: string): void {
    this._entries.set(uri.toString(), content);
    this._onDidChange.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this._entries.get(uri.toString()) ?? '';
  }
}

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _state: ChatState = {
    status: 'idle',
    connection: 'connected',
    messages: [],
    permissionMode: 'ask',
    model: 'gemini-2.5-pro',
    availableModels: DEFAULT_MODEL_OPTIONS,
    availableCommands: DEFAULT_SLASH_COMMANDS,
    gcloud: { account: null, project: null },
    // Phase 39 W2: per-turn search mode defaults to `local`. The webview
    // toggle (W3) drives transitions; New Conversation resets it.
    searchMode: 'local',
  };
  private _activeAssistantId: string | null = null;
  private _loadingNativeSession = false;
  private _queue: Array<{
    id: string;
    text: string;
    /** @deprecated W2 bridge — prefer `attachments`. Kept for stream-json fallback. */
    images?: ImageAttachment[];
    /** Phase 39 W2: per-turn search mode persisted into the queued turn. */
    searchMode: SearchMode;
    /** Phase 39 W2: discriminated attachment chips for the queued turn. */
    attachments?: AttachmentChip[];
  }> = [];
  private _generationId = 0;
  private _turnId = 0;
  private _activeTurnId: number | null = null;
  private _turnSnapshots = new Map<number, string | null>();
  private _turnSnapshotPromises = new Map<number, Promise<void>>();
  private _changeDecorationType?: vscode.TextEditorDecorationType;
  private readonly _contextFileUri: vscode.Uri;
  private readonly _sessionManager?: GeminiSessionManager;
  private readonly _calmuiMcpServers: AcpMcpServer[];
  private _mcpServers: AcpMcpServer[];
  private _mcpServerSignature = '';
  private _currentSessionId: string | null = null;
  private _contextRefreshTimer: NodeJS.Timeout | null = null;
  private readonly _memoryDiffProvider = new MemoryDiffContentProvider();

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _extensionUri: vscode.Uri,
    private readonly _geminiProcess: GeminiTransport,
    private readonly _outputChannel: vscode.OutputChannel,
    sessionManager?: GeminiSessionManager,
    private readonly _runDiagnostics?: (options?: { notify?: boolean }) => Promise<DiagnosticsReport>,
  ) {
    const persistedDiagnostics = this._context.workspaceState.get<DiagnosticsReport>(DIAGNOSTICS_KEY);
    if (persistedDiagnostics) {
      // Phase 39 W2: rehydrate `searchAvailable` from the persisted report
      // so the toggle pill state survives reload.
      const sgRow = persistedDiagnostics.checks.find((c) => c.id === 'search-grounding');
      this._state = {
        ...this._state,
        diagnostics: persistedDiagnostics,
        ...(sgRow
          ? {
              searchAvailable: sgRow.status === 'pass',
              searchUnavailableReason: sgRow.status === 'pass' ? null : sgRow.detail,
            }
          : {}),
      };
    }
    const persistedMcp = this._context.workspaceState.get<ChatState['mcp']>(MCP_INSPECTOR_KEY);
    if (persistedMcp) {
      this._state = { ...this._state, mcp: persistedMcp };
    }
    const persistedExtensions = this._context.workspaceState.get<GeminiExtensionReport>(EXTENSIONS_KEY);
    if (persistedExtensions) {
      this._state = { ...this._state, extensions: persistedExtensions };
    }
    const persistedMemory = this._context.workspaceState.get<MemoryState>(MEMORY_STATE_KEY);
    if (persistedMemory) {
      this._state = { ...this._state, memory: persistedMemory };
    }
    const persistedCheckpoints = this._context.workspaceState.get<CheckpointState>(CHECKPOINT_STATE_KEY);
    if (persistedCheckpoints) {
      this._state = { ...this._state, checkpoints: persistedCheckpoints };
    }

    this._changeDecorationType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.modifiedForeground'),
      backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
      border: '1px solid',
      borderColor: new vscode.ThemeColor('editorGutter.modifiedBackground'),
    });
    this._context.subscriptions.push(this._changeDecorationType);
    this._sessionManager = sessionManager;
    this._contextFileUri = vscode.Uri.joinPath(this._context.globalStorageUri, 'editor-context.json');
    this._calmuiMcpServers = [{
      name: 'calmui-context',
      command: process.execPath,
      args: [vscode.Uri.joinPath(this._extensionUri, 'media', 'calmui-context-mcp-server.js').fsPath],
      env: [{ name: 'CALMUI_CONTEXT_FILE', value: this._contextFileUri.fsPath }],
    }];
    this._mcpServers = this._resolveConfiguredMcpServers();
    this._mcpServerSignature = getMcpServerSignature(this._mcpServers);
    this._sessionManager?.setMcpServers(this._getAcpSessionMcpServers());
    this._sessionManager?.process.setDiscoveryCallbacks((_rawLine, parsed) => {
      if (this._loadingNativeSession) {
        this._applyLoadedSessionEvent(parsed);
      }
      this._applyDiscoveryEvents(parsed);
      this._postState();
    });
    this._sessionManager?.setRecoveryStateCallback((state) => {
      this._applyRecoveryState(state);
    });
    this._sessionManager?.setHealthStateCallback((state) => {
      this._applyHealthState(state);
    });

    this._context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => this._scheduleEditorContextRefresh()),
      vscode.window.onDidChangeVisibleTextEditors(() => this._scheduleEditorContextRefresh()),
      vscode.window.onDidChangeTextEditorSelection(() => this._scheduleEditorContextRefresh()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (vscode.window.visibleTextEditors.some(editor => editor.document === event.document)) {
          this._scheduleEditorContextRefresh();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('calmui') && this._state.diagnostics) {
          void this._handleRunDiagnostics({ notify: false });
        }
        if (event.affectsConfiguration('calmui') && this._state.mcp) {
          void this._handleRefreshMcpInspector();
        }
      }),
      vscode.workspace.registerTextDocumentContentProvider(MEMORY_DIFF_SCHEME, this._memoryDiffProvider),
      new vscode.Disposable(() => {
        if (this._contextRefreshTimer) {
          clearTimeout(this._contextRefreshTimer);
          this._contextRefreshTimer = null;
        }
      }),
    );
  }

  openMemoryStudio(prefill?: string): void {
    this._postMessage({ type: 'openMemoryStudio', prefill });
    void this._handleRefreshMemory();
  }

  openCheckpointBrowser(): void {
    this._postMessage({ type: 'openCheckpointBrowser' });
    void this._handleRefreshCheckpoints();
  }

  openExtensionManager(): void {
    this._postMessage({ type: 'openExtensionManager' });
    void this._handleRefreshExtensions();
  }

  private _isAcpMode(): boolean {
    return this._sessionManager !== undefined;
  }

  private _resolveConfiguredMcpServers(): AcpMcpServer[] {
    const workspaceFolders = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
    const discovery = discoverGeminiMcpServers({ workspaceFolders });
    for (const warning of discovery.warnings) {
      this._outputChannel.appendLine(`[MCP INSPECTOR] ${warning}`);
    }
    if (discovery.settingsPaths.length > 0) {
      this._outputChannel.appendLine(`[MCP INSPECTOR] loaded Gemini MCP settings from ${discovery.settingsPaths.join(', ')}`);
    }
    return mergeMcpServers(this._calmuiMcpServers, discovery.servers);
  }

  private _refreshConfiguredMcpServers(): boolean {
    const nextServers = this._resolveConfiguredMcpServers();
    const nextSignature = getMcpServerSignature(nextServers);
    const changed = nextSignature !== this._mcpServerSignature;
    this._mcpServers = nextServers;
    this._mcpServerSignature = nextSignature;
    this._sessionManager?.setMcpServers(this._getAcpSessionMcpServers());
    return changed;
  }

  private _getAcpSessionMcpServers(): AcpMcpServer[] {
    const attachMcpServers = vscode.workspace
      .getConfiguration('calmui')
      .get<boolean>('attachMcpServersToAcp', false);
    if (attachMcpServers) return this._mcpServers;
    return [];
  }

  private async _ensureAcpSession(): Promise<SessionHandle> {
    if (this._currentSessionId) {
      const existing = this._sessionManager!.getSession(this._currentSessionId);
      if (existing) return existing;
    }
    this._refreshConfiguredMcpServers();
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const handle = await this._sessionManager!.createSession(cwd);
    this._currentSessionId = handle.sessionId;
    return handle;
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'dist'),
        vscode.Uri.joinPath(this._extensionUri, 'media'),
      ],
    };
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    await this._refreshEditorContext();
    this._postState();

    this._state = { ...this._state, gcloud: await readGcloudStatusAsync() };
    this._postState();
    if (this._isAcpMode()) {
      void this._handleRefreshMcpInspector();
    }

    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      try {
        switch (message.type) {
        case 'sendPrompt':
          void this._handleSendPrompt(
            message.text,
            message.searchMode,
            message.attachments,
            message.images ?? [],
          );
          break;
        case 'cancelGeneration':
          if (this._isAcpMode() && this._currentSessionId) {
            this._generationId++;
            this._outputChannel.appendLine(`[CANCEL] ACP cancel session=${this._currentSessionId} token=${this._generationId}`);
            this._sessionManager!.process.cancelSession(this._currentSessionId);
            this._activeAssistantId = null;
            this._activeToolId = null;
            this._stopStallTimer();
            this._state = { ...this._state, status: 'idle', connection: 'connected' };
            this._postState();
          } else {
            this._killAndReset();
          }
          this._postMessage({ type: 'generationAborted' });
          break;
        case 'cancelPending':
          this._queue = this._queue.filter(q => q.id !== message.id);
          this._state = {
            ...this._state,
            messages: this._state.messages.filter(m => m.id !== message.id),
            queueLength: this._queue.length,
          };
          this._postState();
          break;
        case 'clearQueue':
          // Separate from Stop: clears queued prompts without aborting
          // the current streaming turn.
          this._queue = [];
          this._state = {
            ...this._state,
            messages: this._state.messages.filter(m => !m.pending),
            queueLength: 0,
          };
          this._postState();
          break;
        case 'clearConversation':
          if (this._isAcpMode() && this._currentSessionId) {
            // ACP path: cancel session, create new one — process stays alive
            this._sessionManager!.destroySession(this._currentSessionId);
            this._currentSessionId = null;
            this._generationId++;
            this._outputChannel.appendLine(`[CANCEL] session destroyed, token=${this._generationId}`);
            this._state = { ...this._state, status: 'idle', connection: 'connected' };
          } else {
            // Stream-json path: unchanged
            this._killAndReset();
          }
          this._activeAssistantId = null;
          this._activeToolId = null;
          this._queue = [];
          this._stopStallTimer();
          if (!this._isAcpMode()) this._archiveCurrentSession();
          this._state = {
            ...this._state,
            messages: [],
            errorMessage: undefined,
            usage: undefined,
            session: undefined,
            receivingStartedAt: undefined,
            stalled: false,
            queueLength: 0,
            // Phase 39 D-02: New Conversation resets per-turn search mode to
            // 'local'. Each session starts deliberate-by-default; the user
            // must opt back into Search via the segmented pill.
            searchMode: 'local',
          };
          this._postState();
          break;
        case 'showHistory':
          await this._showHistoryPicker();
          break;
        case 'openCheckpointBrowser':
          this.openCheckpointBrowser();
          break;
        case 'refreshCheckpoints':
          await this._handleRefreshCheckpoints();
          break;
        case 'saveCheckpoint':
          await this._handleSaveCheckpoint(message.tag);
          break;
        case 'resumeManualCheckpoint':
          await this._handleResumeManualCheckpoint(message.tag);
          break;
        case 'restoreGeminiCheckpoint':
          await this._handleRestoreGeminiCheckpoint(message.checkpointId);
          break;
        case 'restoreNativeSession':
          await this._handleRestoreNativeSession(message.sessionId);
          break;
        case 'openGeminiSettings':
          await openGeminiSettings();
          break;
        case 'openVSCodeSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:veles.gemini-cli-calmui');
          break;
        case 'runDiagnostics':
          await this._handleRunDiagnostics();
          break;
        case 'includeCurrentFile':
          await this._includeCurrentFile();
          break;
        case 'resolveDroppedFiles':
          await this._resolveDroppedFiles(message.uris);
          break;
        case 'setPermissionMode':
          this._state = { ...this._state, permissionMode: message.mode };
          this._postState();
          break;
        case 'setModel':
          this._state = { ...this._state, model: message.model };
          this._postState();
          break;
        case 'setSearchMode':
          // Phase 39 W3: persist the user's per-turn search-mode choice in
          // ChatState so subsequent turns ride it (D-02) and so diagnostics /
          // export builders can read the current mode.
          this._state = { ...this._state, searchMode: message.mode };
          this._postState();
          break;
        case 'openExternal':
          // Phase 39 W3: SourcesSection row clicks route through the host so
          // we use the workbench's external-URL handler (respects user's
          // browser settings + trust prompts).
          try {
            await vscode.env.openExternal(vscode.Uri.parse(message.url));
          } catch (err) {
            this._outputChannel.appendLine(`[OPEN-EXTERNAL] ${message.url}: ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        case 'refreshGcloudStatus':
          this._state = { ...this._state, gcloud: await readGcloudStatusAsync() };
          this._postState();
          break;
        case 'retryAcp':
          if (this._isAcpMode()) {
            await this._sessionManager!.process.restart();
            this._state = { ...this._state, connection: 'connected', status: 'idle', errorMessage: undefined };
            this._postState();
          } else {
            await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:veles.gemini-cli-calmui calmui.useAcp');
          }
          break;
        case 'refreshMcpInspector':
          await this._handleRefreshMcpInspector();
          break;
        case 'openExtensionManager':
          this.openExtensionManager();
          break;
        case 'refreshExtensions':
          await this._handleRefreshExtensions();
          break;
        case 'installExtension':
          await this._handleInstallExtension(message.url);
          break;
        case 'enableExtension':
          await this._handleExtensionNameAction('enable', message.name);
          break;
        case 'disableExtension':
          await this._handleExtensionNameAction('disable', message.name);
          break;
        case 'updateExtension':
          await this._handleExtensionNameAction('update', message.name);
          break;
        case 'openExtensionManifest':
          await vscode.window.showTextDocument(vscode.Uri.file(message.path), { preview: false });
          break;
        case 'openMemoryStudio':
          this.openMemoryStudio();
          break;
        case 'refreshMemory':
          await this._handleRefreshMemory();
          break;
        case 'prepareMemoryAdd':
          this._handlePrepareMemoryAdd(message.text);
          break;
        case 'confirmMemoryAdd':
          await this._handleConfirmMemoryAdd();
          break;
        case 'cancelMemoryAdd':
          await this._updateMemoryState({ pendingAdd: undefined, status: 'idle' });
          break;
        case 'runMemoryInit':
          await this._handleRunMemoryInit();
          break;
        case 'acceptMemoryInit':
          await this._handleAcceptMemoryInit(message.proposalId);
          break;
        case 'rejectMemoryInit':
          await this._handleRejectMemoryInit(message.proposalId);
          break;
        case 'openMemoryFile':
          await vscode.window.showTextDocument(vscode.Uri.file(message.path), { preview: false });
          break;
        case 'copyToClipboard':
          vscode.env.clipboard.writeText(message.text);
          break;
        case 'copyConversation':
          vscode.env.clipboard.writeText(this._exportAsMarkdown());
          break;
        case 'exportConversation': {
          const md = this._exportAsMarkdown();
          if (!md) break;
          const date = new Date().toISOString().slice(0, 10);
          const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri
            ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, `conversation-${date}.md`)
            : undefined;
          const uri = await vscode.window.showSaveDialog({
            defaultUri,
            filters: { Markdown: ['md'], 'All files': ['*'] },
          });
          if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(md, 'utf-8'));
            this._outputChannel.appendLine(`[EXPORT] saved to ${uri.fsPath}`);
          }
          break;
        }
        case 'permissionResponse':
          if (this._isAcpMode()) {
            this._sessionManager!.process.respondPermission(message.messageId, message.optionId);
            // Mark the permission card as resolved
            this._state = {
              ...this._state,
              messages: this._state.messages.map((m): ChatMessage =>
                m.permission && m.permission.messageId === message.messageId
                  ? { ...m, permission: { ...m.permission, resolved: message.optionId } }
                  : m
              ),
            };
            this._postState();
          }
          break;
        case 'stageDiffBlock':
          await this._stageDiffBlock(message.diff);
          break;
        case 'rollbackTurn':
          await this._rollbackTurn(message.turnId);
          break;
        case 'editAndResend':
          void this._editAndResend(
            message.messageId,
            message.text,
            message.searchMode,
            message.attachments,
            message.images ?? [],
          );
          break;
        case 'regenerateResponse':
          void this._regenerateResponse(message.messageId);
          break;
        }
      } catch (err) {
        const details = err instanceof Error ? err.message : String(err);
        this._outputChannel.appendLine(`[WEBVIEW MESSAGE ERROR] ${message.type}: ${details}`);
        this._postMessage({ type: 'error', message: `${message.type} failed: ${details}` });
      }
    });
  }

  /**
   * Phase 39 W2: deprecation bridge. When the webview only sent the legacy
   * `images` array (no `attachments`), promote each image to an `image`-kind
   * `AttachmentChip` so the rest of the pipeline sees a uniform shape.
   */
  private _normalizeAttachments(
    attachments: AttachmentChip[] | undefined,
    images: ImageAttachment[],
  ): AttachmentChip[] {
    if (attachments && attachments.length > 0) return attachments;
    return images.map((img): AttachmentChip => ({
      kind: 'image',
      id: img.id,
      name: img.name,
      mimeType: img.mimeType,
      data: img.data,
    }));
  }

  /**
   * Phase 39 W2: pre-dispatch validation gate. Returns `null` if the chips
   * are safe to send, otherwise a user-facing error message that the caller
   * should surface and abort with.
   *
   * Two gates:
   *   1. Any `kind: 'unsupported'` chip → reject (CalmUI cannot send it).
   *   2. Any `kind: 'pdf'` chip when `getPromptCapabilities().embeddedContext`
   *      is not advertised → reject (this Gemini CLI version cannot accept it).
   */
  private _validateAttachmentsForDispatch(chips: AttachmentChip[]): string | null {
    const unsupported = chips.find((c): c is Extract<AttachmentChip, { kind: 'unsupported' }> => c.kind === 'unsupported');
    if (unsupported) {
      return `Cannot send: ${unsupported.name} is not supported by Gemini.`;
    }
    const hasPdf = chips.some((c) => c.kind === 'pdf');
    if (hasPdf) {
      const caps = this._sessionManager?.process.getPromptCapabilities() ?? null;
      if (caps?.embeddedContext !== true) {
        return 'This Gemini CLI version does not advertise embeddedContext support; PDF cannot be sent.';
      }
    }
    return null;
  }

  private async _handleSendPrompt(
    text: string,
    searchMode: SearchMode,
    attachments: AttachmentChip[] | undefined,
    images: ImageAttachment[],
  ): Promise<void> {
    const prompt = text.trim();
    const chips = this._normalizeAttachments(attachments, images);
    if (!prompt && chips.length === 0) return;

    // Phase 39 W2: pre-dispatch gates (unsupported chip + PDF capability).
    const gateError = this._validateAttachmentsForDispatch(chips);
    if (gateError) {
      this._postMessage({ type: 'error', message: gateError });
      return;
    }

    if (chips.length > 0 && !this._isAcpMode()) {
      this._appendStatusMessage('error', 'Attachments require ACP mode. Enable CalmUI: Use ACP and try again.');
      return;
    }

    if (
      this._isAcpMode()
      && (this._state.connection === 'disconnected'
        || this._state.connection === 'error'
        || this._state.connection === 'reconnecting'
        || this._state.status === 'reconnecting'
        || this._state.status === 'error')
    ) {
      this._state = {
        ...this._state,
        messages: [
          ...this._state.messages,
          {
            id: crypto.randomUUID(),
            role: 'error',
            content: 'Gemini ACP is not connected yet. Wait for the status to return to Connected, then try again.',
          },
        ],
      };
      this._postState();
      return;
    }

    if (this._state.status === 'receiving') {
      const id = crypto.randomUUID();
      this._queue.push({ id, text: prompt, images, searchMode, attachments: chips });
      this._outputChannel.appendLine(`[QUEUE] enqueue id=${id} queueLength=${this._queue.length}`);
      this._state = {
        ...this._state,
        // Phase 39 W2: queued user messages also stamp searchModeAtSend +
        // attachments so W3 can render the globe badge / chip strip on the
        // pending bubble immediately.
        messages: [
          ...this._state.messages,
          {
            id,
            role: 'user',
            content: prompt,
            pending: true,
            searchModeAtSend: searchMode,
            attachments: chips.length > 0 ? chips : undefined,
          },
        ],
        queueLength: this._queue.length,
      };
      this._postState();
      return;
    }

    await this._refreshEditorContext();
    this._startTurn(
      prompt || 'Please analyze the attached image(s).',
      null,
      images,
      searchMode,
      chips,
    );
  }

  private async _editAndResend(
    messageId: string,
    newText: string,
    searchMode: SearchMode,
    attachments: AttachmentChip[] | undefined,
    images: ImageAttachment[],
  ): Promise<void> {
    const prompt = newText.trim();
    const chips = this._normalizeAttachments(attachments, images);
    if (!prompt && chips.length === 0) return;
    if (this._state.status === 'receiving') return;

    // Phase 39 W2: pre-dispatch gates (unsupported chip + PDF capability).
    const gateError = this._validateAttachmentsForDispatch(chips);
    if (gateError) {
      this._postMessage({ type: 'error', message: gateError });
      return;
    }

    // Find the message index and truncate everything from that point
    const idx = this._state.messages.findIndex(m => m.id === messageId);
    if (idx < 0) return;

    if (this._isAcpMode() && this._currentSessionId) {
      this._sessionManager!.destroySession(this._currentSessionId);
      this._currentSessionId = null;
      this._generationId++;
    } else {
      this._killAndReset();
    }
    this._activeAssistantId = null;
    this._activeToolId = null;
    this._queue = [];
    this._stopStallTimer();
    this._state = {
      ...this._state,
      status: 'idle',
      connection: 'connected',
      messages: this._state.messages.slice(0, idx),
      errorMessage: undefined,
      receivingStartedAt: undefined,
      stalled: false,
      queueLength: 0,
    };
    this._postState();
    await this._refreshEditorContext();
    this._startTurn(prompt, null, images, searchMode, chips);
  }

  private async _regenerateResponse(assistantMessageId: string): Promise<void> {
    if (this._state.status === 'receiving') return;

    // Find the assistant message, then find the preceding user message
    const assistantIdx = this._state.messages.findIndex(m => m.id === assistantMessageId);
    if (assistantIdx < 0) return;

    let userIdx = -1;
    for (let i = assistantIdx - 1; i >= 0; i--) {
      if (this._state.messages[i].role === 'user') {
        userIdx = i;
        break;
      }
    }
    if (userIdx < 0) return;
    const userMessage = this._state.messages[userIdx];

    if (this._isAcpMode() && this._currentSessionId) {
      this._sessionManager!.destroySession(this._currentSessionId);
      this._currentSessionId = null;
      this._generationId++;
    } else {
      this._killAndReset();
    }
    this._activeAssistantId = null;
    this._activeToolId = null;
    this._queue = [];
    this._stopStallTimer();
    // Keep messages up to and including the user message, drop everything after
    this._state = {
      ...this._state,
      status: 'idle',
      connection: 'connected',
      messages: this._state.messages.slice(0, userIdx + 1),
      errorMessage: undefined,
      receivingStartedAt: undefined,
      stalled: false,
      queueLength: 0,
    };
    this._postState();
    await this._refreshEditorContext();
    // Phase 39 W2: regenerate inherits the original user turn's search mode
    // and attachments so the resend matches the user's prior intent.
    const inheritedMode = userMessage.searchModeAtSend ?? this._state.searchMode;
    const inheritedChips = userMessage.attachments ?? [];
    this._startTurn(userMessage.content, null, [], inheritedMode, inheritedChips);
  }

  private _stallTimer: NodeJS.Timeout | null = null;
  private _lastEventAt = 0;
  private static readonly STALL_THRESHOLD_MS = 45_000;

  private _bumpActivity(): void {
    this._lastEventAt = Date.now();
    if (this._state.stalled) {
      this._state = { ...this._state, stalled: false };
    }
  }

  private _startStallTimer(): void {
    this._stopStallTimer();
    this._lastEventAt = Date.now();
    this._stallTimer = setInterval(() => {
      if (this._state.status !== 'receiving') return;
      const idle = Date.now() - this._lastEventAt;
      if (idle > ChatPanelProvider.STALL_THRESHOLD_MS && !this._state.stalled) {
        this._state = { ...this._state, stalled: true };
        this._postState();
      }
    }, 5_000);
  }

  private _stopStallTimer(): void {
    if (this._stallTimer) {
      clearInterval(this._stallTimer);
      this._stallTimer = null;
    }
  }

  private _killAndReset(): void {
    this._generationId++;
    this._outputChannel.appendLine(`[CANCEL] kill() token=${this._generationId}`);
    this._activeAssistantId = null;
    this._activeToolId = null;
    this._stopStallTimer();
    this._state = { ...this._state, status: 'idle', connection: 'connected' };
    this._postState();
    this._geminiProcess.kill();
  }

  private _startTurn(
    prompt: string,
    existingMessageId: string | null,
    images: ImageAttachment[] = [],
    searchMode: SearchMode = this._state.searchMode,
    attachments: AttachmentChip[] = [],
  ): void {
    const token = ++this._generationId;
    const turnId = ++this._turnId;
    this._activeTurnId = turnId;
    const snapshotPromise = this._captureTurnSnapshot(turnId);
    this._turnSnapshotPromises.set(turnId, snapshotPromise);
    void snapshotPromise.finally(() => this._turnSnapshotPromises.delete(turnId));
    const guard = createTokenGuard(() => this._generationId, token);
    this._activeAssistantId = null;
    this._activeToolId = null;
    // Phase 39 W2: when promoting a queued/pending user bubble we keep its
    // existing `searchModeAtSend` + `attachments`. New turns stamp them now.
    const stampedAttachments = attachments.length > 0 ? attachments : undefined;
    const nextMessages = existingMessageId
      ? this._state.messages.map((m): ChatMessage =>
          m.id === existingMessageId ? { ...m, pending: undefined } : m
        )
      : [
          ...this._state.messages,
          {
            id: crypto.randomUUID(),
            role: 'user' as const,
            content: prompt,
            searchModeAtSend: searchMode,
            attachments: stampedAttachments,
          },
        ];
    this._state = {
      ...this._state,
      status: 'receiving',
      connection: 'receiving',
      messages: nextMessages,
      errorMessage: undefined,
      receivingStartedAt: Date.now(),
      stalled: false,
      queueLength: this._queue.length,
    };
    this._postState();
    this._startStallTimer();

    if (this._isAcpMode()) {
      // ACP path: ensure session exists, then send with explicit sessionId
      void this._ensureAcpSession().then((handle) => {
        if (!isTokenCurrent(() => this._generationId, token)) {
          this._outputChannel.appendLine(`[ACP] dropped stale turn before send token=${token} current=${this._generationId}`);
          return;
        }
        this._geminiProcess.send(
          prompt,
          {
            model: this._state.model,
            permissionMode: this._state.permissionMode,
            context: this._getPromptContext(),
            images,
            searchMode,
            attachments: stampedAttachments,
          },
          (_rawLine, parsed) => {
            guard(() => {
              this._bumpActivity();
              this._applySessionInit(parsed);
              this._applyErrorEvent(parsed);
              this._applyDiscoveryEvents(parsed);
              this._applyResultStats(parsed);
              this._appendThinkingDelta(parsed);
              this._applyPermissionRequest(parsed);
              this._appendToolActivity(parsed);
              this._appendAssistantDelta(parsed);
              this._postState();
            });
          },
          (exitCode) => {
            guard(() => {
              const assistantId = this._activeAssistantId;
              this._activeAssistantId = null;
              this._activeToolId = null;
              this._stopStallTimer();
              this._appendEmptyTurnWarning(assistantId, exitCode);
              this._state = {
                ...this._state,
                status: 'idle',
                connection: 'connected',
                receivingStartedAt: undefined,
                stalled: false,
              };
              this._postMessage({ type: 'generationDone', exitCode });
              this._postState();
              void this._finalizeCodingTurn(turnId, assistantId);
              this._flushQueue(token);
            });
          },
          (errMsg) => {
            guard(() => {
              const assistantId = this._activeAssistantId;
              this._activeAssistantId = null;
              this._activeToolId = null;
              this._stopStallTimer();
              this._state = {
                ...this._state,
                status: 'idle',
                connection: 'connected',
                receivingStartedAt: undefined,
                stalled: false,
                messages: [
                  ...this._state.messages,
                  { id: crypto.randomUUID(), role: 'error', content: errMsg },
                ],
              };
              this._postState();
              void this._finalizeCodingTurn(turnId, assistantId);
              this._flushQueue(token);
            });
          },
          undefined, // onStderrWarning — ACP handles stderr via its own channel
          handle.sessionId,
        );
      }).catch((err) => {
        guard(() => {
          this._state = {
            ...this._state,
            status: 'idle',
            connection: 'connected',
            messages: [
              ...this._state.messages,
              { id: crypto.randomUUID(), role: 'error', content: `Session error: ${err instanceof Error ? err.message : String(err)}` },
            ],
          };
          this._postState();
        });
      });
    } else {
      // Stream-json path: unchanged
      this._geminiProcess.send(
        prompt,
        {
          model: this._state.model,
          permissionMode: this._state.permissionMode,
          context: this._getPromptContext(),
          images,
          searchMode,
          attachments: stampedAttachments,
        },
        (_rawLine, parsed) => {
          guard(() => {
            this._bumpActivity();
            this._applySessionInit(parsed);
            this._applyErrorEvent(parsed);
            this._applyDiscoveryEvents(parsed);
            this._applyResultStats(parsed);
            this._appendThinkingDelta(parsed);
            this._applyPermissionRequest(parsed);
            this._appendToolActivity(parsed);
            this._appendAssistantDelta(parsed);
            this._postState();
          });
        },
        (exitCode) => {
          guard(() => {
            const assistantId = this._activeAssistantId;
            this._activeAssistantId = null;
            this._activeToolId = null;
            this._stopStallTimer();
            this._appendEmptyTurnWarning(assistantId, exitCode);
            this._state = {
              ...this._state,
              status: 'idle',
              connection: 'connected',
              receivingStartedAt: undefined,
              stalled: false,
            };
            this._postMessage({ type: 'generationDone', exitCode });
            this._postState();
            void this._finalizeCodingTurn(turnId, assistantId);
            this._flushQueue(token);
          });
        },
        (errMsg) => {
          guard(() => {
            const assistantId = this._activeAssistantId;
            this._activeAssistantId = null;
            this._activeToolId = null;
            this._stopStallTimer();
            this._state = {
              ...this._state,
              status: 'idle',
              connection: 'connected',
              receivingStartedAt: undefined,
              stalled: false,
              messages: [
                ...this._state.messages,
                { id: crypto.randomUUID(), role: 'error', content: errMsg },
              ],
            };
            this._postState();
            void this._finalizeCodingTurn(turnId, assistantId);
            this._flushQueue(token);
          });
        },
        (warning) => {
          guard(() => {
            this._bumpActivity();
            this._state = {
              ...this._state,
              messages: [
                ...this._state.messages,
                { id: crypto.randomUUID(), role: 'warning', content: warning },
              ],
            };
            this._postState();
          });
        },
      );
    }
  }

  private async _captureTurnSnapshot(turnId: number): Promise<void> {
    const cwd = this._getWorkspaceCwd();
    if (!cwd) {
      this._turnSnapshots.set(turnId, null);
      return;
    }

    try {
      await runGit(cwd, 'rev-parse --is-inside-work-tree');
      const stash = (await runGit(cwd, `stash create "calmui-turn-${turnId}"`)).trim();
      const fallbackHead = (await runGit(cwd, 'rev-parse --verify HEAD')).trim();
      this._turnSnapshots.set(turnId, stash || fallbackHead || null);
    } catch (err) {
      this._outputChannel.appendLine(`[CODING] snapshot unavailable: ${err instanceof Error ? err.message : String(err)}`);
      this._turnSnapshots.set(turnId, null);
    }
  }

  private async _finalizeCodingTurn(turnId: number, assistantId: string | null): Promise<void> {
    if (this._activeTurnId === turnId) this._activeTurnId = null;
    await this._turnSnapshotPromises.get(turnId);
    const snapshot = this._turnSnapshots.get(turnId);
    if (!snapshot) return;

    const cwd = this._getWorkspaceCwd();
    if (!cwd) return;

    try {
      const files = await this._readChangedFiles(cwd, snapshot);
      if (files.length === 0) return;

      this._state = {
        ...this._state,
        messages: this._state.messages.map((message): ChatMessage =>
          message.id === assistantId
            ? {
                ...message,
                changeSummary: {
                  turnId,
                  files,
                  rollbackAvailable: true,
                },
              }
            : message
        ),
      };
      this._postState();
      await this._decorateChangedLines(cwd, snapshot);
      await this._refreshCheckpointTurnRestorePoints();
    } catch (err) {
      this._outputChannel.appendLine(`[CODING] change summary failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async _readChangedFiles(cwd: string, snapshot: string): Promise<ChangedFile[]> {
    const output = await runGit(cwd, `diff --numstat ${snapshot} --`);
    return output
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map((line): ChangedFile | null => {
        const parts = line.split(/\t+/);
        if (parts.length < 3) return null;
        return {
          additions: parts[0] === '-' ? 0 : Number(parts[0]) || 0,
          deletions: parts[1] === '-' ? 0 : Number(parts[1]) || 0,
          path: parts.slice(2).join('\t'),
        };
      })
      .filter((file): file is ChangedFile => file !== null);
  }

  private async _decorateChangedLines(cwd: string, snapshot: string): Promise<void> {
    if (!this._changeDecorationType) return;
    const diff = await runGit(cwd, `diff --unified=0 ${snapshot} --`);
    const rangesByPath = parseAddedLineRanges(diff);
    for (const editor of vscode.window.visibleTextEditors) {
      const relative = normalizePath(vscode.workspace.asRelativePath(editor.document.uri, false));
      const ranges = rangesByPath.get(relative) ?? [];
      editor.setDecorations(this._changeDecorationType, ranges);
    }
  }

  private async _stageDiffBlock(diff: string): Promise<void> {
    const cwd = this._getWorkspaceCwd();
    if (!cwd) {
      this._appendStatusMessage('error', 'No workspace is open, so CalmUI could not stage that diff.');
      return;
    }
    try {
      await runGitWithInput(cwd, ['apply', '--cached', '--whitespace=nowarn', '-'], diff);
      this._appendStatusMessage('warning', 'Diff block staged in git index.');
    } catch (err) {
      this._appendStatusMessage('error', `Could not stage diff block: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async _rollbackTurn(turnId: number): Promise<void> {
    const cwd = this._getWorkspaceCwd();
    const snapshot = this._turnSnapshots.get(turnId);
    if (!cwd || !snapshot) {
      this._appendStatusMessage('error', 'Rollback is unavailable for this turn because no git snapshot was captured.');
      return;
    }

    try {
      const patch = await runGit(cwd, `diff --binary ${snapshot} --`);
      if (!patch.trim()) {
        this._appendStatusMessage('warning', `Turn ${turnId} has no file changes to roll back.`);
        return;
      }
      await runGitWithInput(cwd, ['apply', '-R', '--whitespace=nowarn', '-'], patch);
      this._appendStatusMessage('warning', `Rolled back file changes from turn ${turnId}.`);
      const files = await this._readChangedFiles(cwd, snapshot);
      this._state = {
        ...this._state,
        messages: this._state.messages.map((message): ChatMessage =>
          message.changeSummary?.turnId === turnId
            ? {
                ...message,
                changeSummary: {
                  ...message.changeSummary,
                  files,
                  rollbackAvailable: false,
                },
              }
            : message
        ),
      };
      this._postState();
      await this._decorateChangedLines(cwd, snapshot);
      await this._refreshCheckpointTurnRestorePoints();
    } catch (err) {
      this._appendStatusMessage('error', `Rollback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private _appendStatusMessage(role: 'warning' | 'error', content: string): void {
    this._state = {
      ...this._state,
      messages: [
        ...this._state.messages,
        { id: crypto.randomUUID(), role, content },
      ],
    };
    this._postState();
  }

  private _getWorkspaceCwd(): string | null {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  }

  private async _refreshEditorContext(): Promise<void> {
    const snapshot = this._buildEditorContextSnapshot();
    try {
      await vscode.workspace.fs.createDirectory(this._context.globalStorageUri);
      await vscode.workspace.fs.writeFile(
        this._contextFileUri,
        Buffer.from(JSON.stringify(snapshot, null, 2), 'utf8'),
      );
    } catch (err) {
      this._outputChannel.appendLine(`[CONTEXT] failed to write editor context: ${err instanceof Error ? err.message : String(err)}`);
    }
    this._state = {
      ...this._state,
      context: {
        activeFile: snapshot.activeFile?.path,
        hasSelection: Boolean(snapshot.activeFile?.selection),
        selectionChars: snapshot.activeFile?.selection.length,
        visibleFiles: snapshot.visibleFiles.map(file => file.path),
        mcpEnabled: this._isAcpMode(),
      },
    };
  }

  private _scheduleEditorContextRefresh(delayMs = 250): void {
    if (this._contextRefreshTimer) {
      clearTimeout(this._contextRefreshTimer);
    }
    this._contextRefreshTimer = setTimeout(() => {
      this._contextRefreshTimer = null;
      void this._refreshEditorContext().then(() => this._postState());
    }, delayMs);
  }

  private _buildEditorContextSnapshot(): EditorContextSnapshot {
    const active = vscode.window.activeTextEditor;
    const visibleFiles = vscode.window.visibleTextEditors
      .map(editor => this._readEditorContext(editor, false))
      .filter((entry): entry is EditorFileContext => entry !== null);
    return {
      workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
      capturedAt: new Date().toISOString(),
      activeFile: active ? this._readEditorContext(active, true) : null,
      visibleFiles,
    };
  }

  private _readEditorContext(editor: vscode.TextEditor, includeText: boolean): EditorFileContext | null {
    if (editor.document.uri.scheme !== 'file') return null;
    const selection = editor.selection.isEmpty ? '' : editor.document.getText(editor.selection);
    return {
      uri: editor.document.uri.toString(),
      path: vscode.workspace.asRelativePath(editor.document.uri, false),
      languageId: editor.document.languageId,
      cursor: {
        line: editor.selection.active.line + 1,
        character: editor.selection.active.character + 1,
      },
      selection,
      text: includeText ? editor.document.getText() : undefined,
    };
  }

  private _getPromptContext(): GeminiSendOptions['context'] {
    const active = vscode.window.activeTextEditor;
    const file = active ? this._readEditorContext(active, true) : null;
    if (!file?.text) return undefined;
    return { activeFile: { ...file, text: file.text } };
  }

  private async _includeCurrentFile(): Promise<void> {
    await this._refreshEditorContext();
    const active = vscode.window.activeTextEditor;
    if (!active || active.document.uri.scheme !== 'file') {
      this._appendStatusMessage('error', 'No file editor is active, so CalmUI could not insert an @-reference.');
      return;
    }
    const relative = vscode.workspace.asRelativePath(active.document.uri, false).replace(/\\/g, '/');
    this._postMessage({ type: 'insertDraftText', text: ` @${relative}` });
  }

  private async _resolveDroppedFiles(uris: string[]): Promise<void> {
    const refs: string[] = [];
    for (const raw of uris) {
      let uri: vscode.Uri;
      try {
        uri = vscode.Uri.parse(raw);
      } catch {
        continue;
      }
      if (uri.scheme !== 'file') continue;
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type & vscode.FileType.Directory) {
          this._postMessage({ type: 'insertDraftText', text: '' });
          this._appendStatusMessage('warning', 'Drop individual files, not folders.');
          continue;
        }
      } catch {
        continue;
      }
      refs.push(`@${vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/')}`);
    }
    if (refs.length > 0) {
      this._postMessage({ type: 'insertDraftText', text: ` ${refs.join(' ')}` });
    }
  }

  private _flushQueue(flushToken?: number): void {
    if (flushToken !== undefined && flushToken !== this._generationId) {
      this._outputChannel.appendLine(`[QUEUE] flush dropped — stale token ${flushToken} vs current ${this._generationId}`);
      return;
    }
    const next = this._queue.shift();
    if (!next) {
      this._outputChannel.appendLine('[QUEUE] empty — no flush needed');
      return;
    }
    this._outputChannel.appendLine(`[QUEUE] flush next=${next.id} remaining=${this._queue.length}`);
    this._state = { ...this._state, queueLength: this._queue.length };
    this._startTurn(
      next.text,
      next.id,
      next.images ?? [],
      next.searchMode,
      next.attachments ?? [],
    );
  }

  private _appendAssistantDelta(parsed: unknown): void {
    const content = getAssistantContent(parsed);
    if (!content) return;

    if (!this._activeAssistantId) {
      this._activeAssistantId = crypto.randomUUID();
      this._state = {
        ...this._state,
        messages: [
          ...this._state.messages,
          { id: this._activeAssistantId, role: 'assistant', content },
        ],
      };
      return;
    }

    this._state = {
      ...this._state,
      messages: this._state.messages.map((message): ChatMessage => (
        message.id === this._activeAssistantId
          ? { ...message, content: message.content + content }
          : message
      )),
    };
  }

  private _applyLoadedSessionEvent(parsed: unknown): void {
    const userContent = getUserContent(parsed);
    if (userContent) {
      this._activeAssistantId = null;
      this._state = {
        ...this._state,
        messages: [
          ...this._state.messages,
          { id: crypto.randomUUID(), role: 'user', content: userContent },
        ],
      };
      return;
    }

    this._appendAssistantDelta(parsed);
    this._appendThinkingDelta(parsed);
    this._appendToolActivity(parsed);
  }

  private _appendThinkingDelta(parsed: unknown): void {
    const content = getThinkingContent(parsed);
    if (!content) return;

    // Thinking attaches to the current or next assistant message
    if (!this._activeAssistantId) {
      this._activeAssistantId = crypto.randomUUID();
      this._state = {
        ...this._state,
        messages: [
          ...this._state.messages,
          { id: this._activeAssistantId, role: 'assistant', content: '', thinking: content },
        ],
      };
      return;
    }

    this._state = {
      ...this._state,
      messages: this._state.messages.map((message): ChatMessage => (
        message.id === this._activeAssistantId
          ? { ...message, thinking: (message.thinking ?? '') + content }
          : message
      )),
    };
  }

  private _applyPermissionRequest(parsed: unknown): void {
    const req = getPermissionRequest(parsed);
    if (!req) return;

    const id = crypto.randomUUID();
    this._state = {
      ...this._state,
      messages: [
        ...this._state.messages,
        {
          id,
          role: 'tool',
          content: `Permission requested: ${req.toolName}`,
          permission: {
            toolName: req.toolName,
            args: req.args,
            options: req.options,
            messageId: req.messageId,
          },
        },
      ],
    };
  }

  private _activeToolId: string | null = null;

  private _applySessionInit(parsed: unknown): void {
    const info = getInitInfo(parsed);
    if (!info) return;
    this._state = { ...this._state, session: info };
  }

  private _appendEmptyTurnWarning(assistantId: string | null, exitCode: number | null): void {
    // If this turn produced no assistant content, show a visible warning so
    // the user isn't left staring at a silent stop.
    if (assistantId) {
      const msg = this._state.messages.find(m => m.id === assistantId);
      if (msg && msg.content) return; // has real content — nothing to warn about
    }
    // No assistant message was created, or it was created with only thinking/empty content.
    const detail = exitCode !== null && exitCode !== 0 ? ` (exit code ${exitCode})` : '';
    this._state = {
      ...this._state,
      messages: [
        ...this._state.messages,
        {
          id: crypto.randomUUID(),
          role: 'warning',
          content: `Gemini returned no response${detail}. This can happen when the model is overloaded, the prompt was filtered, or the connection dropped mid-turn. Try sending the message again.`,
        },
      ],
    };
  }

  private _applyErrorEvent(parsed: unknown): void {
    const err = getErrorEvent(parsed);
    if (!err) return;
    this._state = {
      ...this._state,
      messages: [
        ...this._state.messages,
        { id: crypto.randomUUID(), role: 'error', content: err },
      ],
    };
  }

  private _applyResultStats(parsed: unknown): void {
    const usage = getResultUsage(parsed);
    if (!usage) return;
    this._state = { ...this._state, usage };
  }

  private _applyRecoveryState(recovery: RecoveryState): void {
    if (recovery.status === 'reconnecting') {
      this._currentSessionId = null;
      this._activeToolId = null;
      this._stopStallTimer();
      const messages = recovery.hadActivePrompt
        ? [
            ...this._state.messages,
            {
              id: crypto.randomUUID(),
              role: 'error' as const,
              content: 'Connection lost — response incomplete. Reconnecting to Gemini ACP...',
            },
          ]
        : this._state.messages;
      this._state = {
        ...this._state,
        status: 'reconnecting',
        connection: 'reconnecting',
        messages,
        receivingStartedAt: undefined,
        stalled: false,
      };
      this._postState();
      return;
    }

    if (recovery.status === 'ready') {
      this._state = {
        ...this._state,
        status: 'idle',
        connection: 'connected',
        receivingStartedAt: undefined,
        stalled: false,
      };
      this._postState();
      return;
    }

    this._currentSessionId = null;
    this._activeAssistantId = null;
    this._activeToolId = null;
    this._stopStallTimer();
    this._state = {
      ...this._state,
      status: 'error',
      connection: 'error',
      receivingStartedAt: undefined,
      stalled: false,
      messages: [
        ...this._state.messages,
        { id: crypto.randomUUID(), role: 'error', content: recovery.message },
      ],
    };
    this._postState();
  }

  private _applyHealthState(health: HealthState): void {
    const connection = health.status;
    const nextState: ChatState = {
      ...this._state,
      connection,
    };

    if (health.status === 'error') {
      const alreadyShowingHealthError = this._state.connection === 'error'
        && this._state.errorMessage === health.message;
      nextState.status = 'error';
      nextState.errorMessage = health.message;
      if (!alreadyShowingHealthError) {
        nextState.messages = [
          ...this._state.messages,
          { id: crypto.randomUUID(), role: 'error', content: health.message },
        ];
      }
    } else if (this._state.status === 'error' && health.status === 'connected') {
      nextState.status = 'idle';
      nextState.errorMessage = undefined;
    }

    this._state = nextState;
    this._postState();
  }

  private _applyDiscoveryEvents(parsed: unknown): void {
    const modelUpdate = getAvailableModels(parsed);
    if (modelUpdate) {
      const hasCurrentModel = modelUpdate.models.some(model => model.id === this._state.model);
      this._state = {
        ...this._state,
        availableModels: modelUpdate.models,
        model: hasCurrentModel
          ? this._state.model
          : modelUpdate.selectedModel ?? modelUpdate.models[0]?.id ?? this._state.model,
      };
    }

    const commands = getAvailableCommands(parsed);
    if (commands) {
      this._state = { ...this._state, availableCommands: commands };
    }
  }

  private _appendToolActivity(parsed: unknown): void {
    const activity = getToolActivity(parsed);
    if (!activity) return;

    // Consolidate tool activity into a single message that updates in place.
    // Instead of 50+ individual "Using X" / "Finished X" messages, keep one
    // rolling status line that shows the latest activity.
    if (this._activeToolId) {
      this._state = {
        ...this._state,
        messages: this._state.messages.map((msg) =>
          msg.id === this._activeToolId
            ? { ...msg, content: activity }
            : msg
        ),
      };
    } else {
      this._activeToolId = crypto.randomUUID();
      this._state = {
        ...this._state,
        messages: [
          ...this._state.messages,
          { id: this._activeToolId, role: 'tool', content: activity },
        ],
      };
    }
  }

  private _postMessage(message: ExtensionMessage): void {
    this._view?.webview.postMessage(message);
  }

  private _postState(): void {
    this._postMessage({ type: 'chatState', state: this._state });
  }

  private async _handleRunDiagnostics(options: { notify?: boolean } = {}): Promise<void> {
    const report = this._runDiagnostics
      ? await this._runDiagnostics(options)
      : await vscode.commands.executeCommand<DiagnosticsReport>('calmui.runDiagnostics');
    if (!report) return;
    // Phase 39 W2: populate `searchAvailable` + `searchUnavailableReason`
    // from the `search-grounding` row so the W3 toggle pill can disable
    // itself and surface a hover reason without re-deriving from the report.
    const sgRow = report.checks.find((c) => c.id === 'search-grounding');
    let searchAvailable: boolean | undefined;
    let searchUnavailableReason: string | null | undefined;
    if (sgRow) {
      searchAvailable = sgRow.status === 'pass';
      searchUnavailableReason = searchAvailable ? null : sgRow.detail;
    }
    this._state = {
      ...this._state,
      diagnostics: report,
      ...(searchAvailable !== undefined ? { searchAvailable, searchUnavailableReason } : {}),
    };
    await this._context.workspaceState.update(DIAGNOSTICS_KEY, report);
    this._postState();
  }

  private async _handleRefreshMcpInspector(): Promise<void> {
    try {
      const changed = this._refreshConfiguredMcpServers();
      const restartRequired = changed && Boolean(this._currentSessionId);
      const report = await inspectMcpServers(this._mcpServers, { restartRequired });
      this._state = { ...this._state, mcp: report };
      await this._context.workspaceState.update(MCP_INSPECTOR_KEY, report);
      this._postState();
      if (restartRequired) {
        this._outputChannel.appendLine('[MCP INSPECTOR] MCP configuration changed; restart the Gemini ACP session before expecting Gemini to use the new server set.');
      }
    } catch (err) {
      const details = err instanceof Error ? err.message : String(err);
      this._outputChannel.appendLine(`[MCP INSPECTOR] refresh failed: ${details}`);
      this._appendStatusMessage('warning', `MCP inspector refresh failed: ${details}`);
    }
  }

  private async _handleRefreshExtensions(options: { restartRequired?: boolean; lastAction?: string } = {}): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
    const report = discoverGeminiExtensions({
      workspaceFolders,
      restartRequired: options.restartRequired ?? this._state.extensions?.restartRequired ?? false,
      lastAction: options.lastAction ?? this._state.extensions?.lastAction,
    });
    for (const warning of report.warnings) {
      this._outputChannel.appendLine(`[EXTENSIONS] ${warning}`);
    }
    await this._setExtensionReport(report);
  }

  private async _handleInstallExtension(url: string): Promise<void> {
    const trimmed = url.trim();
    if (!isSafeExtensionUrl(trimmed)) {
      this._appendStatusMessage('warning', 'Extension install requires an HTTPS or git@ URL.');
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Install Gemini CLI extension from ${trimmed}? Extensions can contribute commands, context, hooks, and MCP servers that run local code.`,
      { modal: true },
      'Install',
    );
    if (choice !== 'Install') return;
    await this._runExtensionTerminalCommand('install', trimmed);
  }

  private async _handleExtensionNameAction(action: 'enable' | 'disable' | 'update', name: string): Promise<void> {
    const trimmed = name.trim();
    if (!isSafeExtensionName(trimmed)) {
      this._appendStatusMessage('warning', `Extension ${action} requires a simple extension name.`);
      return;
    }
    const actionLabel = action[0].toUpperCase() + action.slice(1);
    const message = action === 'update'
      ? `Update Gemini CLI extension "${trimmed}"? Updated extension code may change commands, hooks, context, or MCP servers.`
      : `${actionLabel} Gemini CLI extension "${trimmed}"? Changes may require a new Gemini session before they take effect.`;
    const choice = await vscode.window.showWarningMessage(message, { modal: true }, actionLabel);
    if (choice !== actionLabel) return;
    await this._runExtensionTerminalCommand(action, trimmed);
  }

  private async _runExtensionTerminalCommand(action: 'install' | 'enable' | 'disable' | 'update', target: string): Promise<void> {
    const geminiPath = vscode.workspace.getConfiguration('calmui').get<string>('geminiPath', 'gemini').trim() || 'gemini';
    const command = `${quoteTerminalArg(geminiPath)} extensions ${action} ${quoteTerminalArg(target)}`;
    const terminal = vscode.window.createTerminal({
      name: 'CalmUI Gemini Extensions',
      cwd: this._getWorkspaceCwd() ?? undefined,
    });
    terminal.show();
    terminal.sendText(command);
    const restartRequired = Boolean(this._currentSessionId);
    await this._handleRefreshExtensions({
      restartRequired,
      lastAction: `${action} ${target}`,
    });
    this._appendStatusMessage(
      'warning',
      `Started "gemini extensions ${action}" in the CalmUI Gemini Extensions terminal. ${restartRequired ? 'Restart the Gemini session before relying on extension changes.' : 'Refresh Extension Manager after the command finishes.'}`,
    );
  }

  private async _setExtensionReport(extensions: GeminiExtensionReport): Promise<void> {
    this._state = { ...this._state, extensions };
    await this._context.workspaceState.update(EXTENSIONS_KEY, extensions);
    this._postState();
  }

  private async _handleRefreshMemory(): Promise<void> {
    const loading: MemoryState = {
      status: 'loading',
      sources: this._state.memory?.sources ?? [],
      generatedAt: this._state.memory?.generatedAt,
      pendingAdd: this._state.memory?.pendingAdd,
      initProposal: this._state.memory?.initProposal,
    };
    this._state = { ...this._state, memory: loading };
    this._postState();

    try {
      const memory = await discoverMemoryState({ workspaceRoot: this._getWorkspaceCwd() });
      await this._setMemoryState({
        ...memory,
        pendingAdd: this._state.memory?.pendingAdd,
        initProposal: this._state.memory?.initProposal,
      });
    } catch (err) {
      await this._setMemoryState({
        status: 'error',
        generatedAt: new Date().toISOString(),
        sources: this._state.memory?.sources ?? [],
        error: err instanceof Error ? err.message : String(err),
        pendingAdd: this._state.memory?.pendingAdd,
        initProposal: this._state.memory?.initProposal,
      });
    }
  }

  private async _handleRefreshCheckpoints(): Promise<void> {
    const loading: CheckpointState = {
      status: 'loading',
      generatedAt: this._state.checkpoints?.generatedAt,
      nativeSessions: this._state.checkpoints?.nativeSessions ?? [],
      manualCheckpoints: this._state.checkpoints?.manualCheckpoints ?? [],
      restoreCheckpoints: this._state.checkpoints?.restoreCheckpoints ?? [],
      turnRestorePoints: this._getTurnRestorePoints(),
      dirtyWorktree: await this._isWorktreeDirty(),
    };
    await this._setCheckpointState(loading);

    try {
      const cwd = this._getWorkspaceCwd() ?? process.cwd();
      const nativeSessions = this._isAcpMode()
        ? await this._sessionManager!.listNativeSessions(cwd)
        : this._context.workspaceState.get<ChatSession[]>(SESSIONS_KEY, []);
      const manualResult = this._isAcpMode()
        ? await this._tryCheckpointListCommand('/chat list')
        : { output: '', error: undefined };
      const restoreResult = this._isAcpMode()
        ? await this._tryCheckpointListCommand('/restore')
        : { output: '', error: undefined };
      const partialErrors = [manualResult.error, restoreResult.error].filter(Boolean).join(' ');
      await this._setCheckpointState({
        status: partialErrors ? 'error' : 'idle',
        generatedAt: new Date().toISOString(),
        nativeSessions,
        manualCheckpoints: parseManualCheckpointTags(manualResult.output),
        restoreCheckpoints: parseGeminiRestoreCheckpoints(restoreResult.output),
        turnRestorePoints: this._getTurnRestorePoints(),
        dirtyWorktree: await this._isWorktreeDirty(),
        error: partialErrors || undefined,
      });
    } catch (err) {
      const details = err instanceof Error ? err.message : String(err);
      await this._setCheckpointState({
        status: 'error',
        generatedAt: new Date().toISOString(),
        nativeSessions: this._state.checkpoints?.nativeSessions ?? [],
        manualCheckpoints: this._state.checkpoints?.manualCheckpoints ?? [],
        restoreCheckpoints: this._state.checkpoints?.restoreCheckpoints ?? [],
        turnRestorePoints: this._getTurnRestorePoints(),
        dirtyWorktree: await this._isWorktreeDirty(),
        error: details,
      });
      this._appendStatusMessage('error', `Checkpoint refresh failed: ${details}. Next action: run diagnostics or try Refresh Checkpoints again.`);
    }
  }

  private async _handleSaveCheckpoint(tag: string): Promise<void> {
    const safeTag = tag.trim();
    if (!isSafeCheckpointTag(safeTag)) {
      await this._updateCheckpointState({
        status: 'error',
        error: 'Checkpoint tag must be 1-64 characters using letters, numbers, dot, underscore, or dash.',
      });
      return;
    }
    await this._updateCheckpointState({ status: 'saving', error: undefined });
    try {
      await this._runCheckpointCommand(`/chat save ${safeTag}`);
      this._appendStatusMessage('warning', `Saved Gemini chat checkpoint "${safeTag}".`);
      await this._handleRefreshCheckpoints();
    } catch (err) {
      const details = err instanceof Error ? err.message : String(err);
      await this._updateCheckpointState({ status: 'error', error: `Could not save checkpoint: ${details}` });
      this._appendStatusMessage('error', `Could not save checkpoint "${safeTag}": ${details}. Next action: check the CalmUI output channel, then try Save again.`);
    }
  }

  private async _handleResumeManualCheckpoint(tag: string): Promise<void> {
    const safeTag = tag.trim();
    if (!isSafeCheckpointTag(safeTag)) return;
    if (!await this._confirmDirtyWorktree(`Resume Gemini chat checkpoint "${safeTag}"?`)) return;
    await this._restoreViaCheckpointCommand(`/chat resume ${safeTag}`, `Resumed Gemini chat checkpoint "${safeTag}".`);
  }

  private async _handleRestoreGeminiCheckpoint(checkpointId: string): Promise<void> {
    const id = checkpointId.trim();
    if (!id) return;
    if (!await this._confirmDirtyWorktree(`Restore Gemini file checkpoint "${id}"?`)) return;
    await this._restoreViaCheckpointCommand(`/restore ${id}`, `Restored Gemini file checkpoint "${id}".`);
  }

  private async _handleRestoreNativeSession(sessionId: string): Promise<void> {
    if (!this._isAcpMode()) return;
    if (!await this._confirmDirtyWorktree(`Load Gemini native session "${sessionId}"?`)) return;
    await this._loadNativeSession(sessionId, 'Checkpoint Browser');
  }

  private async _restoreViaCheckpointCommand(command: string, successMessage: string): Promise<void> {
    await this._updateCheckpointState({ status: 'restoring', error: undefined });
    try {
      await this._runCheckpointCommand(command);
      this._generationId++;
      this._activeAssistantId = null;
      this._activeToolId = null;
      this._queue = [];
      this._stopStallTimer();
      this._state = {
        ...this._state,
        status: 'idle',
        connection: 'connected',
        messages: [
          ...this._state.messages,
          { id: crypto.randomUUID(), role: 'warning', content: successMessage },
        ],
        receivingStartedAt: undefined,
        stalled: false,
        queueLength: 0,
      };
      await this._handleRefreshCheckpoints();
    } catch (err) {
      const details = err instanceof Error ? err.message : String(err);
      await this._updateCheckpointState({ status: 'error', error: details });
      this._appendStatusMessage('error', `Restore failed: ${details}. Next action: run Refresh Checkpoints, then retry the same restore.`);
    }
  }

  private async _runCheckpointCommand(command: string): Promise<string> {
    if (this._state.status === 'receiving') {
      throw new Error('Wait for the current Gemini turn to finish before using checkpoints.');
    }
    return this._runSideChannelCommand(command);
  }

  private async _tryCheckpointListCommand(command: string): Promise<{ output: string; error?: string }> {
    try {
      return { output: await this._runCheckpointCommand(command) };
    } catch (err) {
      const details = err instanceof Error ? err.message : String(err);
      return {
        output: '',
        error: `${command} unavailable: ${details}.`,
      };
    }
  }

  private async _confirmDirtyWorktree(title: string): Promise<boolean> {
    if (!await this._isWorktreeDirty()) return true;
    await this._updateCheckpointState({ dirtyWorktree: true });
    const choice = await vscode.window.showWarningMessage(
      `${title} Your git worktree has uncommitted changes. Restoring may overwrite local work.`,
      { modal: true },
      'Continue',
    );
    return choice === 'Continue';
  }

  private async _isWorktreeDirty(): Promise<boolean> {
    const cwd = this._getWorkspaceCwd();
    if (!cwd) return false;
    try {
      await runGit(cwd, 'rev-parse --is-inside-work-tree');
      return Boolean((await runGit(cwd, 'status --porcelain')).trim());
    } catch {
      return false;
    }
  }

  private _getTurnRestorePoints(): CheckpointState['turnRestorePoints'] {
    return this._state.messages
      .map(message => message.changeSummary)
      .filter((summary): summary is NonNullable<ChatMessage['changeSummary']> => Boolean(summary))
      .map(summary => ({
        turnId: summary.turnId,
        filesChanged: summary.files.length,
        additions: summary.files.reduce((sum, file) => sum + file.additions, 0),
        deletions: summary.files.reduce((sum, file) => sum + file.deletions, 0),
        rollbackAvailable: summary.rollbackAvailable,
      }));
  }

  private async _refreshCheckpointTurnRestorePoints(): Promise<void> {
    if (!this._state.checkpoints) return;
    await this._updateCheckpointState({
      turnRestorePoints: this._getTurnRestorePoints(),
      dirtyWorktree: await this._isWorktreeDirty(),
    });
  }

  private async _updateCheckpointState(patch: Partial<CheckpointState>): Promise<void> {
    await this._setCheckpointState({
      status: 'idle',
      nativeSessions: [],
      manualCheckpoints: [],
      restoreCheckpoints: [],
      turnRestorePoints: [],
      dirtyWorktree: false,
      ...this._state.checkpoints,
      ...patch,
    });
  }

  private async _setCheckpointState(checkpoints: CheckpointState): Promise<void> {
    this._state = { ...this._state, checkpoints };
    await this._context.workspaceState.update(CHECKPOINT_STATE_KEY, checkpoints);
    this._postState();
  }

  private _handlePrepareMemoryAdd(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const targetPath = getProjectMemoryPath(this._getWorkspaceCwd());
    void this._updateMemoryState({
      status: 'idle',
      pendingAdd: { text: trimmed, targetPath },
      error: undefined,
    });
  }

  private async _handleConfirmMemoryAdd(): Promise<void> {
    const pending = this._state.memory?.pendingAdd;
    if (!pending) return;
    if (this._state.status === 'receiving') {
      await this._updateMemoryState({ status: 'error', error: 'Wait for the current Gemini turn to finish before saving memory.' });
      return;
    }

    await this._updateMemoryState({ status: 'saving', error: undefined });
    try {
      await this._runSideChannelCommand(`/memory add ${pending.text}`);
      await this._updateMemoryState({ pendingAdd: undefined, status: 'idle' });
      await this._handleRefreshMemory();
      vscode.window.showInformationMessage('Memory saved through Gemini CLI.');
    } catch (err) {
      await this._updateMemoryState({
        status: 'error',
        error: `Could not save memory: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private async _handleRunMemoryInit(): Promise<void> {
    const workspaceRoot = this._getWorkspaceCwd();
    const targetPath = getProjectMemoryPath(workspaceRoot);
    const projectSource = this._state.memory?.sources.find(source => source.path === targetPath);
    const currentContent = projectSource?.content ?? '';
    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? 'Workspace';
    const proposal = createInitProposal({ targetPath, currentContent, workspaceName });
    await this._showMemoryDiff(proposal);
    await this._updateMemoryState({ initProposal: proposal, error: undefined, status: 'idle' });
  }

  private async _handleAcceptMemoryInit(proposalId: string): Promise<void> {
    const proposal = this._state.memory?.initProposal;
    if (!proposal || proposal.id !== proposalId) return;
    if (this._state.status === 'receiving') {
      await this._updateMemoryState({ status: 'error', error: 'Wait for the current Gemini turn to finish before running /init.' });
      return;
    }

    await this._updateMemoryState({ status: 'saving', error: undefined });
    try {
      await this._runSideChannelCommand('/init');
      await this._updateMemoryState({ initProposal: undefined, status: 'idle' });
      await this._handleRefreshMemory();
      vscode.window.showInformationMessage('/init sent through Gemini CLI. Review any permission card before allowing file changes.');
    } catch (err) {
      await this._updateMemoryState({
        status: 'error',
        error: `Could not run /init: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private async _handleRejectMemoryInit(proposalId: string): Promise<void> {
    const proposal = this._state.memory?.initProposal;
    if (!proposal || proposal.id !== proposalId) return;
    await this._updateMemoryState({ initProposal: undefined, status: 'idle', error: undefined });
  }

  private async _showMemoryDiff(proposal: MemoryInitProposal): Promise<void> {
    const left = vscode.Uri.from({
      scheme: MEMORY_DIFF_SCHEME,
      path: `/${proposal.id}/current/GEMINI.md`,
      query: proposal.targetPath,
    });
    const right = vscode.Uri.from({
      scheme: MEMORY_DIFF_SCHEME,
      path: `/${proposal.id}/proposed/GEMINI.md`,
      query: proposal.targetPath,
    });
    this._memoryDiffProvider.set(left, proposal.currentContent);
    this._memoryDiffProvider.set(right, proposal.proposedContent);
    await vscode.commands.executeCommand('vscode.diff', left, right, `Memory Studio: ${proposal.targetPath}`);
  }

  private async _runSideChannelCommand(command: string): Promise<string> {
    if (!this._isAcpMode()) {
      throw new Error('This action requires ACP mode.');
    }
    if (this._state.status === 'receiving') {
      throw new Error('A Gemini turn is already running.');
    }

    await this._refreshEditorContext();
    const handle = await this._ensureAcpSession();
    return new Promise((resolve, reject) => {
      let output = '';
      let settled = false;
      this._geminiProcess.send(
        command,
        {
          model: this._state.model,
          permissionMode: this._state.permissionMode,
          context: this._getPromptContext(),
          memoryBuffer: true,
          // Phase 39 W2: side-channel commands (e.g. /memory show) are
          // implementation calls, not user prompts. Always send `local` so
          // the prefix never inadvertently invites a search.
          searchMode: 'local',
        },
        (_rawLine, parsed) => {
          this._applyDiscoveryEvents(parsed);
          this._applySessionInit(parsed);
          this._applyResultStats(parsed);
          const assistant = getAssistantContent(parsed);
          if (assistant) output += assistant;
        },
        (exitCode) => {
          if (settled) return;
          settled = true;
          if (exitCode && exitCode !== 0) {
            reject(new Error(`Gemini CLI exited with code ${exitCode}.`));
          } else {
            resolve(output);
          }
        },
        (err) => {
          if (settled) return;
          settled = true;
          reject(new Error(err));
        },
        undefined,
        handle.sessionId,
      );
    });
  }

  private async _updateMemoryState(patch: Partial<MemoryState>): Promise<void> {
    await this._setMemoryState({
      status: 'idle',
      sources: [],
      ...this._state.memory,
      ...patch,
    });
  }

  private async _setMemoryState(memory: MemoryState): Promise<void> {
    this._state = { ...this._state, memory };
    await this._context.workspaceState.update(MEMORY_STATE_KEY, memory);
    this._postState();
  }

  private _exportAsMarkdown(): string {
    return buildMarkdownExport(this._state);
  }

  private _archiveCurrentSession(): void {
    if (this._isAcpMode()) return;
    const messages = this._state.messages.filter(m => m.role !== 'tool' && !m.pending);
    if (messages.length === 0) return;
    const firstUser = messages.find(m => m.role === 'user');
    const title = (firstUser?.content ?? 'Conversation').slice(0, 80).replace(/\s+/g, ' ').trim();
    const session: ChatSession = {
      id: crypto.randomUUID(),
      title: title || 'Conversation',
      createdAt: new Date().toISOString(),
      messageCount: messages.length,
      messages,
    };
    const existing = this._context.workspaceState.get<ChatSession[]>(SESSIONS_KEY, []);
    const updated = [session, ...existing].slice(0, MAX_SESSIONS);
    this._context.workspaceState.update(SESSIONS_KEY, updated);
  }

  private async _showHistoryPicker(): Promise<void> {
    if (this._isAcpMode()) {
      await this._showNativeHistoryPicker();
      return;
    }

    const sessions = this._context.workspaceState.get<ChatSession[]>(SESSIONS_KEY, []);
    if (sessions.length === 0) {
      vscode.window.showInformationMessage('No chat history yet — start a conversation and it will be saved when you click New.');
      return;
    }
    const items = sessions.map((s) => ({
      label: s.title,
      description: `${s.messageCount} message${s.messageCount === 1 ? '' : 's'}`,
      detail: new Date(s.createdAt).toLocaleString(),
      sessionId: s.id,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Restore a previous conversation',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return;
    const session = sessions.find(s => s.id === picked.sessionId);
    if (!session) return;

    if (this._isAcpMode() && this._currentSessionId) {
      this._sessionManager!.destroySession(this._currentSessionId);
      this._currentSessionId = null;
      this._generationId++;
      this._state = { ...this._state, status: 'idle', connection: 'connected' };
    } else {
      this._killAndReset();
    }
    this._activeAssistantId = null;
    this._activeToolId = null;
    this._queue = [];
    this._stopStallTimer();
    if (!this._isAcpMode()) this._archiveCurrentSession();
    this._state = {
      ...this._state,
      messages: session.messages,
      errorMessage: undefined,
      receivingStartedAt: undefined,
      stalled: false,
      queueLength: 0,
    };
    this._postState();
  }

  private async _showNativeHistoryPicker(): Promise<void> {
    const cwd = this._getWorkspaceCwd() ?? process.cwd();
    let sessions: ChatSessionSummary[];
    try {
      sessions = await this._sessionManager!.listNativeSessions(cwd);
    } catch (err) {
      this._appendStatusMessage('error', `Could not read Gemini native sessions: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (sessions.length === 0) {
      vscode.window.showInformationMessage('No Gemini native sessions found for this project yet.');
      return;
    }

    const sorted = [...sessions].sort((a, b) =>
      new Date(b.updatedAt ?? b.createdAt).getTime() - new Date(a.updatedAt ?? a.createdAt).getTime()
    );
    const items = sorted.map((s) => ({
      label: s.title,
      description: s.messageCount > 0
        ? `${s.messageCount} message${s.messageCount === 1 ? '' : 's'}`
        : 'Gemini native session',
      detail: `${new Date(s.updatedAt ?? s.createdAt).toLocaleString()} - ${s.id}`,
      sessionId: s.id,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Restore a Gemini native session',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return;
    await this._loadNativeSession(picked.sessionId, 'History');
  }

  private async _loadNativeSession(sessionId: string, source: string): Promise<void> {
    const cwd = this._getWorkspaceCwd() ?? process.cwd();
    if (this._currentSessionId) {
      this._sessionManager!.destroySession(this._currentSessionId);
      this._currentSessionId = null;
    }

    this._generationId++;
    this._activeAssistantId = null;
    this._activeToolId = null;
    this._queue = [];
    this._stopStallTimer();
    this._loadingNativeSession = true;
    this._state = {
      ...this._state,
      status: 'idle',
      connection: 'connected',
      messages: [],
      errorMessage: undefined,
      usage: undefined,
      receivingStartedAt: undefined,
      stalled: false,
      queueLength: 0,
    };
    this._postState();

    try {
      const handle = await this._sessionManager!.loadSession(cwd, sessionId);
      this._currentSessionId = handle.sessionId;
      this._state = {
        ...this._state,
        session: handle.chatState.session ?? { sessionId: handle.sessionId },
      };
      if (source !== 'History') {
        this._appendStatusMessage('warning', `${source}: loaded Gemini native session ${sessionId}.`);
      }
      this._postState();
    } catch (err) {
      this._appendStatusMessage('error', `Could not load Gemini native session: ${err instanceof Error ? err.message : String(err)}. Next action: pick Refresh Checkpoints and try another session.`);
    } finally {
      this._loadingNativeSession = false;
      this._activeAssistantId = null;
      this._activeToolId = null;
      await this._refreshCheckpointTurnRestorePoints();
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    // Fresh nonce per resolveWebviewView() call — never reuse (Pitfall 3)
    const nonce = crypto.randomBytes(16).toString('base64');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview.js'),
    );
    const logoUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'gemini-logo.svg'),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}';
             style-src ${webview.cspSource} 'unsafe-inline';
             img-src ${webview.cspSource} data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="calmui-logo" content="${logoUri}">
  <title>CalmUI for Gemini CLI</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}


import { exec, spawn } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

async function runGit(cwd: string, args: string): Promise<string> {
  const { stdout } = await execAsync(
    `git ${args}`,
    { cwd, windowsHide: true, timeout: 15000, shell: process.platform === 'win32' ? 'cmd.exe' : undefined },
  );
  return stdout;
}

function runGitWithInput(cwd: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `git ${args.join(' ')} exited with code ${code}`));
      }
    });
    child.stdin.end(input);
  });
}

function parseAddedLineRanges(diff: string): Map<string, vscode.Range[]> {
  const ranges = new Map<string, vscode.Range[]>();
  let currentPath: string | null = null;
  for (const line of diff.split(/\r?\n/)) {
    const fileMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (fileMatch) {
      currentPath = normalizePath(fileMatch[2]);
      if (!ranges.has(currentPath)) ranges.set(currentPath, []);
      continue;
    }
    if (!currentPath) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    const start = Math.max(0, Number(hunk[1]) - 1);
    const count = Number(hunk[2] ?? '1');
    if (count === 0) continue;
    ranges.get(currentPath)!.push(new vscode.Range(start, 0, start + Math.max(1, count), 0));
  }
  return ranges;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function parseManualCheckpointTags(output: string): CheckpointState['manualCheckpoints'] {
  const seen = new Set<string>();
  const checkpoints: CheckpointState['manualCheckpoints'] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^(available|saved|chat|checkpoints?|tags?:\s*$|no\s+)/i.test(line)) continue;
    const match = /(?:^[-*]\s*)?(?:tag:\s*)?([A-Za-z0-9._-]{1,80})(?:\s|$)/i.exec(line);
    const tag = match?.[1];
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    checkpoints.push({ tag });
  }
  return checkpoints;
}

function parseGeminiRestoreCheckpoints(output: string): CheckpointState['restoreCheckpoints'] {
  const seen = new Set<string>();
  const checkpoints: CheckpointState['restoreCheckpoints'] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^(available|restore|checkpoints?|no\s+)/i.test(line)) continue;
    const idMatch = /([0-9]{4}-[0-9]{2}-[0-9]{2}T[^\s,;]+|checkpoint-[^\s,;]+|[A-Za-z0-9._-]+-[A-Za-z0-9._-]+-[A-Za-z0-9._-]+)/.exec(line);
    const id = idMatch?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    checkpoints.push({ id, detail: line === id ? undefined : line });
  }
  return checkpoints;
}

function isSafeCheckpointTag(tag: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(tag.trim());
}

async function readGcloudStatusAsync(): Promise<GcloudStatus> {
  const useVertexAI = vscode.workspace.getConfiguration('calmui').get<boolean>('useVertexAI', true);

  const runGcloud = async (args: string[], timeout = 10000): Promise<{ value: string | null; stderr: string }> => {
    const result = await runGcloudCommand(args, timeout);
    const lines = result.stdout.split('\n').map(l => l.trim())
      .filter(l => l && !l.startsWith('Your active configuration is:') && l !== '(unset)');
    return {
      value: lines[0] || null,
      stderr: [result.error, result.stderr].filter(Boolean).join(' ').trim(),
    };
  };

  // When using Vertex AI, Gemini CLI authenticates via application default
  // credentials (ADC), NOT via gcloud config account. Check ADC first.
  if (useVertexAI) {
    // Quick ADC check — if this succeeds, auth is working regardless of
    // what gcloud config says.
    // Token minting needs a network round trip on top of gcloud.cmd's Python
    // startup; 8-10s is normal on Windows, so give it real headroom.
    const adcResult = await runGcloud(['auth', 'application-default', 'print-access-token'], 20000);
    const projectResult = await runGcloud(['config', 'get-value', 'project']);

    if (adcResult.value) {
      // ADC works. Try to get account for display, but don't fail if missing.
      const accountResult = await runGcloud(['config', 'get-value', 'account']);
      return {
        account: accountResult.value || 'Vertex AI (ADC)',
        project: projectResult.value,
      };
    }

    // ADC failed — this is the real problem
    return {
      account: null,
      project: null,
      errorMessage: 'Vertex AI credentials not found. Run:\ngcloud auth application-default login\nThen click to refresh.',
    };
  }

  // Non-Vertex path: check regular gcloud account
  const [accountResult, projectResult] = await Promise.all([
    runGcloud(['config', 'get-value', 'account']),
    runGcloud(['config', 'get-value', 'project']),
  ]);

  const account = accountResult.value;
  const project = projectResult.value;

  if (!account) {
    return { account: null, project: null, errorMessage: formatGcloudProbeError(accountResult.stderr) };
  }
  return { account, project };
}

function formatGcloudProbeError(stderr: string): string {
  const message = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('Your active configuration is:'))
    .join(' ')
    .trim();

  if (!message || message.toLowerCase() === '(unset)') {
    return "Google Cloud isn't signed in. Open a terminal and run:\ngcloud auth login\nThen click this message to refresh.";
  }

  const normalized = message.toLowerCase();
  if (normalized.includes('not recognized') || normalized.includes('command not found')) {
    return 'gcloud was not found. Install Google Cloud CLI and run "gcloud auth login".';
  }

  if (normalized.includes('not logged in') || normalized.includes('no credential')) {
    return "Google Cloud isn't signed in. Open a terminal and run:\ngcloud auth login\nThen click this message to refresh.";
  }

  return `Unable to read gcloud config: ${message}`;
}

async function openGeminiSettings(): Promise<void> {
  const homeDir = process.env.USERPROFILE || process.env.HOME || '';
  const userSettings = homeDir
    ? vscode.Uri.file(`${homeDir}/.gemini/settings.json`.replace(/\\/g, '/'))
    : null;
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workspaceSettings = workspaceFolder
    ? vscode.Uri.joinPath(workspaceFolder.uri, '.gemini', 'settings.json')
    : null;

  const items: Array<{ label: string; description: string; uri: vscode.Uri }> = [];
  if (userSettings) {
    items.push({ label: 'User settings', description: userSettings.fsPath, uri: userSettings });
  }
  if (workspaceSettings) {
    items.push({ label: 'Workspace settings', description: workspaceSettings.fsPath, uri: workspaceSettings });
  }
  if (items.length === 0) {
    vscode.window.showErrorMessage('Could not locate a Gemini settings path.');
    return;
  }

  const picked = items.length === 1
    ? items[0]
    : await vscode.window.showQuickPick(items, { placeHolder: 'Open Gemini CLI settings' });
  if (!picked) return;

  try {
    await vscode.workspace.fs.stat(picked.uri);
  } catch {
    // Create parent dir + empty settings file if missing
    const dir = vscode.Uri.joinPath(picked.uri, '..');
    try { await vscode.workspace.fs.createDirectory(dir); } catch { /* ignore if exists */ }
    await vscode.workspace.fs.writeFile(picked.uri, Buffer.from('{\n}\n', 'utf8'));
  }
  const doc = await vscode.workspace.openTextDocument(picked.uri);
  await vscode.window.showTextDocument(doc);
}

function isSafeExtensionName(name: string): boolean {
  return /^[A-Za-z0-9._/-]{1,120}$/.test(name) && !name.includes('..');
}

function isSafeExtensionUrl(url: string): boolean {
  return /^https:\/\/\S{1,500}$/i.test(url) || /^git@[A-Za-z0-9_.-]+:[A-Za-z0-9_.\/-]+\.git$/i.test(url);
}

function quoteTerminalArg(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}
