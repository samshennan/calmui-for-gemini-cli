import { spawn, spawnSync, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as readline from 'readline';
import * as vscode from 'vscode';
import { classifyStderrLine } from '../shared/stderr';
import type { GeminiSendOptions, GeminiTransport } from './GeminiTransport';

export class GeminiProcess implements GeminiTransport {
  private _proc: ChildProcess | null = null;
  private _outputChannel: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel) {
    this._outputChannel = outputChannel;
  }

  send(
    prompt: string,
    options: GeminiSendOptions,
    onChunk: (line: string, parsed: unknown) => void,
    onDone: (exitCode: number | null) => void,
    onError: (err: string) => void,
    onStderrWarning?: (warning: string) => void,
  ): void {
    this.kill(); // abort any running generation first

    const config = vscode.workspace.getConfiguration('calmui');
    const geminiPath = config.get<string>('geminiPath', 'gemini');
    const useVertexAI = config.get<boolean>('useVertexAI', true);
    const gcpProject = config.get<string>('googleCloudProject', '').trim();
    const includeDirs = (config.get<string[]>('includeDirectories', []) ?? [])
      .map(d => d.trim())
      .filter(d => d.length > 0);
    const unavailableMessage = getGeminiCliUnavailableMessage(geminiPath);
    if (unavailableMessage) {
      this._outputChannel.appendLine(`[SETUP ERROR] ${unavailableMessage}`);
      onError(unavailableMessage);
      return;
    }

    const isWindows = process.platform === 'win32';
    const approvalMode = options.permissionMode === 'yolo' ? 'yolo' : 'default';
    const modelArgs = options.model === 'auto' ? [] : ['-m', options.model];
    const includeArgs = includeDirs.length > 0 ? ['--include-directories', includeDirs.join(',')] : [];
    const commonArgs = ['-p', prompt, '-o', 'stream-json', '--approval-mode', approvalMode, ...modelArgs, ...includeArgs];
    const command = isWindows
      // Use single command string with short flags to avoid Windows shell
      // word-splitting issues with multi-word prompts (validated in Plan 01).
      ? `${geminiPath} ${quoteArgsForCmd(commonArgs)}`
      : geminiPath;
    const args = isWindows ? [] : commonArgs;

    const spawnEnv: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: 'dumb', // mitigates Windows headless hang (issue #12362)
    };
    if (useVertexAI) {
      spawnEnv.GOOGLE_GENAI_USE_VERTEXAI = 'true';
      // Set API-key vars to empty string rather than deleting. Gemini CLI's
      // dotenv loader populates missing vars from ~/.gemini/.env and the
      // workspace .gemini/.env, so a `delete` is re-filled by the file.
      // An empty string is treated as "defined" by dotenv (no override) and
      // as falsy by gemini's "is the API key set?" check, which forces the
      // Vertex AI auth path.
      spawnEnv.GEMINI_API_KEY = '';
      spawnEnv.GOOGLE_API_KEY = '';
      if (gcpProject) spawnEnv.GOOGLE_CLOUD_PROJECT = gcpProject;
    } else {
      // API-key mode: an inherited GOOGLE_GENAI_USE_VERTEXAI=true would otherwise
      // survive via `...process.env` and silently force the Vertex auth path.
      // Empty string (not delete) so the gemini dotenv loader does not re-fill it.
      spawnEnv.GOOGLE_GENAI_USE_VERTEXAI = '';
    }
    this._outputChannel.appendLine(
      `[SPAWN] vertex=${useVertexAI} project=${spawnEnv.GOOGLE_CLOUD_PROJECT || '(inherited/unset)'} ` +
      `gemini_key=${spawnEnv.GEMINI_API_KEY ? 'set' : 'empty/none'} ` +
      `google_key=${spawnEnv.GOOGLE_API_KEY ? 'set' : 'empty/none'}`,
    );

    this._proc = spawn(command, args, {
      shell: isWindows, // required for .cmd shim resolution
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'], // stdin closed, stdout/stderr piped
    });

    const rl = readline.createInterface({ input: this._proc.stdout! });
    rl.on('line', (line) => {
      if (!line.trim() || !line.startsWith('{')) return; // discard non-JSON startup noise (Pitfall 1)
      this._outputChannel.appendLine(`[STREAM] ${line.slice(0, 120)}`);
      try {
        const parsed = JSON.parse(line);
        onChunk(line, parsed);
      } catch {
        this._outputChannel.appendLine(`[PARSE ERROR] ${line}`);
      }
    });

    // Collect stderr — full buffer is held for exit-time error reporting.
    // Individual stderr lines are also inspected live: patterns that indicate
    // Gemini-side blocks (unknown tool, unauthorized subagent, recursion guard)
    // are surfaced to chat as warning cards via onStderrWarning so the user
    // knows *why* a turn is taking forever.
    let stderrBuffer = '';
    let stderrLineBuffer = '';
    this._proc.stderr!.on('data', (data: Buffer) => {
      const text = data.toString();
      stderrBuffer += text;
      this._outputChannel.appendLine(`[STDERR] ${text.trim()}`);

      if (!onStderrWarning) return;
      stderrLineBuffer += text;
      const lines = stderrLineBuffer.split(/\r?\n/);
      stderrLineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const warning = classifyStderrLine(line);
        if (warning) onStderrWarning(warning);
      }
    });

    this._proc.on('exit', (code) => {
      this._proc = null;
      if (code !== 0 && stderrBuffer.trim()) {
        this._outputChannel.appendLine(`[ERROR] exit code=${code} stderr=${stderrBuffer.trim().slice(0, 300)}`);
        onError(formatGeminiCliError(stderrBuffer.trim()));
      }
      onDone(code);
    });

    this._proc.on('error', (err) => {
      this._outputChannel.appendLine(`[SPAWN ERROR] ${err.message}`);
      onError(formatGeminiCliError(err.message));
    });
  }

  kill(): void {
    if (!this._proc) return;
    this._outputChannel.appendLine(`[CANCEL] killing pid=${this._proc.pid ?? 'unknown'}`);
    const pid = this._proc.pid;
    if (pid !== undefined) {
      if (process.platform === 'win32') {
        // D-09: taskkill /F /T kills entire process tree (cmd.exe + node.exe children)
        spawnSync('taskkill', ['/pid', String(pid), '/f', '/t']);
      } else {
        this._proc.kill('SIGTERM');
      }
    }
    this._proc = null;
  }

  dispose(): void {
    this.kill();
  }
}

function quoteForCmd(value: string): string {
  const escaped = value
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%')
    .replace(/[&|<>()^]/g, '^$&');
  return `"${escaped}"`;
}

function quoteArgsForCmd(args: string[]): string {
  return args.map(quoteForCmd).join(' ');
}

function getGeminiCliUnavailableMessage(geminiPath: string): string | null {
  const configuredPath = geminiPath.trim() || 'gemini';
  if (hasPathSeparator(configuredPath)) {
    return fs.existsSync(configuredPath)
      ? null
      : `Gemini CLI was not found at "${configuredPath}". Set CalmUI: Gemini Path to the full Gemini CLI executable path, or install Gemini CLI and leave the setting as "gemini".`;
  }

  const command = process.platform === 'win32' ? 'where.exe' : 'command';
  const args = process.platform === 'win32' ? [configuredPath] : ['-v', configuredPath];
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    shell: process.platform !== 'win32',
    windowsHide: true,
  });

  if (result.status === 0) return null;

  return `Gemini CLI was not found on PATH as "${configuredPath}". Install Gemini CLI, make sure the command works in a terminal, or set CalmUI: Gemini Path to the full executable path.`;
}

function formatGeminiCliError(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return 'Gemini CLI returned an empty error.';

  if (isMissingGeminiMessage(trimmed)) {
    return 'Gemini CLI was not found. Install Gemini CLI, make sure "gemini" works in a terminal, or set CalmUI: Gemini Path to the full executable path.';
  }

  if (isMissingGcloudAuthMessage(trimmed)) {
    return 'Gemini CLI could not authenticate with Google Cloud. If you use Vertex AI, check that "CalmUI: Use Vertex AI" is enabled and that GOOGLE_CLOUD_PROJECT is set (or configure it in CalmUI settings). Otherwise run "gcloud auth application-default login".\n\nRaw error:\n' + trimmed;
  }

  return trimmed;
}

function hasPathSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

function isMissingGeminiMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('not recognized as an internal or external command')
    || normalized.includes('command not found')
    || normalized.includes('enoent');
}


function isMissingGcloudAuthMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  // Keep these specific — "unauthenticated" alone matches too many unrelated errors
  // and caused false "gcloud auth missing" messages when the real cause was env-var drift.
  return normalized.includes('application default credentials')
    || normalized.includes('default credentials were not found')
    || normalized.includes('could not load the default credentials')
    || normalized.includes('gcloud auth application-default login');
}
