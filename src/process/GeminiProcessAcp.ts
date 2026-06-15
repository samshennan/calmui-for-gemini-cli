import { spawn, spawnSync, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as vscode from 'vscode';
import {
  AcpMessage,
  adaptAcpAvailableCommandsUpdate,
  adaptAcpInitializeResult,
  adaptAcpPromptResult,
  adaptAcpSessionNewResult,
  adaptAcpSessionUpdate,
  buildAcpSelectedPermissionResult,
  parseAcpMessage,
  selectAcpPermissionOption,
} from '../shared/acp';
import type {
  ChatSessionSummary,
  PromptCapabilities,
} from '../shared/messages';
import type { GeminiSendOptions, GeminiTransport } from './GeminiTransport';

// Phase 39 W3: prompt-prefix constants + helper hoisted to `src/shared/searchPrefix`
// so the webview can import them without crossing the `src/webview` ↛ `src/process`
// boundary. Re-exported here for backward compatibility with W2 call sites.
import { LOCAL_PREFIX, SEARCH_PREFIX, applySearchPrefix } from '../shared/searchPrefix';
export { LOCAL_PREFIX, SEARCH_PREFIX, applySearchPrefix };

export type AcpMcpServer =
  | {
      name: string;
      command: string;
      args: string[];
      env: Array<{ name: string; value: string }>;
      cwd?: string;
      timeout?: number;
      description?: string;
      includeTools?: string[];
      excludeTools?: string[];
      oauth?: unknown;
    }
  | {
      name: string;
      type: 'http' | 'sse';
      url: string;
      headers: Array<{ name: string; value: string }>;
      timeout?: number;
      description?: string;
      includeTools?: string[];
      excludeTools?: string[];
      oauth?: unknown;
    }
  | {
      name: string;
      type: 'tcp';
      tcp: string;
      timeout?: number;
      description?: string;
      includeTools?: string[];
      excludeTools?: string[];
      oauth?: unknown;
    };

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
};

type ActiveCallbacks = {
  onChunk: (line: string, parsed: unknown) => void;
  onDone: (exitCode: number | null) => void;
  onError: (err: string) => void;
  permissionMode: GeminiSendOptions['permissionMode'];
};

type DiscoveryCallbacks = {
  onChunk: (line: string, parsed: unknown) => void;
};

export interface AcpProcessExitInfo {
  code: number | null;
  hadActivePrompt: boolean;
  intentional: boolean;
}

export class GeminiProcessAcp implements GeminiTransport {
  private _proc: ChildProcess | null = null;
  private _nextId = 1;
  private _pending = new Map<number, PendingRequest>();
  private _active: ActiveCallbacks | null = null;
  private _discovery: DiscoveryCallbacks | null = null;
  private _starting: Promise<void> | null = null;
  private _promptInFlight = false;
  private _terminating = false;
  private _terminatingPids = new Set<number>();
  private _onProcessExit?: (info: AcpProcessExitInfo) => void;
  private _mcpServers: AcpMcpServer[] = [];
  /**
   * Cached ACP `agentCapabilities.promptCapabilities` from the most recent
   * `initialize` handshake. `null` until the handshake completes, or null when
   * the Gemini CLI version does not advertise the field (older versions).
   * Reset on every `_start()` so re-init does not leak stale capabilities.
   */
  private _promptCapabilities: PromptCapabilities | null = null;

  constructor(private readonly _outputChannel: vscode.OutputChannel) {}

  setOnProcessExit(cb: (info: AcpProcessExitInfo) => void): void {
    this._onProcessExit = cb;
  }

  setDiscoveryCallbacks(onChunk: (line: string, parsed: unknown) => void): void {
    this._discovery = { onChunk };
  }

  setMcpServers(servers: AcpMcpServer[]): void {
    this._mcpServers = servers;
  }

  send(
    prompt: string,
    options: GeminiSendOptions,
    onChunk: (line: string, parsed: unknown) => void,
    onDone: (exitCode: number | null) => void,
    onError: (err: string) => void,
    onStderrWarning?: (warning: string) => void,
    sessionId?: string,
  ): void {
    if (this._promptInFlight) this.kill();
    this._active = { onChunk, onDone, onError, permissionMode: options.permissionMode };
    void this._sendAsync(prompt, options, sessionId).catch((err) => {
      this._outputChannel.appendLine(`[ACP ERROR] ${formatError(err)}`);
      this._active?.onError(formatError(err));
      this._active?.onDone(1);
      this._active = null;
      this._promptInFlight = false;
    });
  }

  async createSession(cwd: string): Promise<{ sessionId: string; adapted: unknown }> {
    await this._ensureStarted();
    const result = await this._request('session/new', { cwd, mcpServers: this._mcpServers });
    const sessionId = readString(result, 'sessionId');
    if (!sessionId) throw new Error('ACP session/new did not return a sessionId.');
    const adapted = adaptAcpSessionNewResult(result);
    return { sessionId, adapted };
  }

  async listSessions(cwd: string): Promise<ChatSessionSummary[]> {
    await this._ensureStarted();
    const result = await this._request('session/list', { cwd, cursor: null });
    return readNativeSessions(result);
  }

  async loadSession(cwd: string, sessionId: string): Promise<{ sessionId: string; adapted: unknown }> {
    await this._ensureStarted();
    const result = await this._request('session/load', {
      cwd,
      sessionId,
      mcpServers: this._mcpServers,
    });
    const adapted = adaptAcpSessionNewResult({ ...(typeof result === 'object' && result ? result : {}), sessionId });
    return { sessionId, adapted };
  }

  cancelSession(sessionId: string): void {
    if (!this._proc) return;
    this._notify('session/cancel', { sessionId });
  }

  kill(): void {
    // In multi-session mode, kill() means "cancel current prompt" not "kill process"
    // Process termination is done via dispose()
    this._rejectPending(new Error('ACP prompt cancelled.'));
    if (this._active) {
      this._active.onDone(1);
      this._active = null;
    }
    this._promptInFlight = false;
  }

  dispose(): void {
    this._terminateProcess();
  }

  async restart(): Promise<void> {
    if (this._proc) this._terminateProcess();
    await this._ensureStarted();
  }

  isRunning(): boolean {
    return this._proc !== null;
  }

  async ping(): Promise<void> {
    await this._ensureStarted();
  }

  /**
   * Returns the cached ACP `agentCapabilities.promptCapabilities` object from
   * the most recent `initialize` handshake.
   *
   * Returns `null` when:
   * - No handshake has completed yet.
   * - The handshake response did not include `agentCapabilities.promptCapabilities`
   *   (older Gemini CLI versions, pre-late-2025).
   *
   * Consumers (Phase 39 PDF chip, diagnostics probe) MUST treat `null` and
   * `{ embeddedContext: false }` as equivalent: PDF native attachment is
   * disabled in both cases.
   */
  public getPromptCapabilities(): PromptCapabilities | null {
    return this._promptCapabilities;
  }

  private async _sendAsync(prompt: string, options: GeminiSendOptions, sessionId?: string): Promise<void> {
    await this._ensureStarted();
    const sid = sessionId;
    if (!sid) throw new Error('sessionId is required for ACP prompt.');

    await this._configureSession(sid, options);

    this._promptInFlight = true;
    const result = await this._request('session/prompt', {
      sessionId: sid,
      prompt: buildAcpPrompt(prompt, options),
    }, 30 * 60_000);

    const adapted = adaptAcpPromptResult(result);
    if (adapted) this._emitAdapted(adapted);
    this._active?.onDone(0);
    this._active = null;
    this._promptInFlight = false;
  }

  private async _ensureStarted(): Promise<void> {
    if (this._proc) return;
    if (this._starting) return this._starting;
    this._starting = this._start();
    try {
      await this._starting;
    } finally {
      this._starting = null;
    }
  }

  private async _start(): Promise<void> {
    // Reset cached capabilities at the start of every (re)init so a previous
    // session's handshake cannot leak into a fresh process.
    this._promptCapabilities = null;
    const config = vscode.workspace.getConfiguration('calmui');
    const geminiPath = config.get<string>('geminiPath', 'gemini');
    const unavailableMessage = getAcpCliUnavailableMessage(geminiPath);
    if (unavailableMessage) throw new Error(unavailableMessage);

    const { command, args } = getAcpSpawnCommand(geminiPath);
    const spawnEnv = getGeminiSpawnEnv();
    this._outputChannel.appendLine(`[ACP SPAWN] command=${command} args=${args.join(' ')}`);
    this._outputChannel.appendLine(
      `[ACP SPAWN] vertex=${spawnEnv.GOOGLE_GENAI_USE_VERTEXAI === 'true'} ` +
      `project=${spawnEnv.GOOGLE_CLOUD_PROJECT || '(inherited/unset)'} ` +
      `gemini_key=${spawnEnv.GEMINI_API_KEY ? 'set' : 'empty/none'} ` +
      `google_key=${spawnEnv.GOOGLE_API_KEY ? 'set' : 'empty/none'}`,
    );

    const proc = spawn(command, args, {
      shell: false,
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this._proc = proc;

    const rl = readline.createInterface({ input: proc.stdout! });
    rl.on('line', (line) => this._handleStdoutLine(line));

    proc.stderr!.on('data', (data: Buffer) => {
      this._outputChannel.appendLine(`[ACP STDERR] ${data.toString().trim()}`);
    });

    proc.on('error', (err) => {
      this._outputChannel.appendLine(`[ACP SPAWN ERROR] ${err.message}`);
      if (this._proc !== proc) return;
      this._rejectPending(err);
      this._active?.onError(err.message);
    });

    proc.on('exit', (code) => {
      const isCurrentProcess = this._proc === proc;
      const pid = proc.pid;
      const intentional = pid !== undefined
        ? this._terminatingPids.delete(pid)
        : this._terminating;
      const hadActivePrompt = isCurrentProcess && (this._active !== null || this._promptInFlight);
      this._outputChannel.appendLine(`[ACP EXIT] code=${code}`);
      if (isCurrentProcess) {
        const active = this._active;
        this._proc = null;
        this._active = null;
        this._promptInFlight = false;
        this._rejectPending(new Error(`ACP process exited with code ${code}`));
        active?.onDone(code);
      }
      if (intentional && this._terminatingPids.size === 0) this._terminating = false;
      this._onProcessExit?.({ code, hadActivePrompt, intentional });
    });

    const initResult = await this._request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'gemini-cli-calmui', version: '1.5.0' },
      capabilities: {},
    });
    for (const adapted of adaptAcpInitializeResult(initResult)) {
      this._emitAdapted(adapted);
    }

    // Phase 39 W0: persist `agentCapabilities.promptCapabilities` from the
    // initialize response. Older Gemini CLI versions may not include this
    // field; coerce missing/non-object payloads to `null` and never throw.
    // RESEARCH.md §2 D-09 + W0 PLAN Risk #1.
    const caps = (initResult as { agentCapabilities?: { promptCapabilities?: unknown } } | null)
      ?.agentCapabilities?.promptCapabilities;
    if (caps && typeof caps === 'object') {
      const c = caps as Record<string, unknown>;
      this._promptCapabilities = {
        image: Boolean(c.image),
        audio: Boolean(c.audio),
        embeddedContext: Boolean(c.embeddedContext),
      };
    } else {
      this._promptCapabilities = null;
    }
  }

  private async _configureSession(sessionId: string, options: GeminiSendOptions): Promise<void> {
    const modeId = options.permissionMode === 'yolo' ? 'yolo' : 'default';
    await this._requestSoft('session/set_mode', { sessionId, modeId });
    if (options.model !== 'auto') {
      await this._requestSoft('session/set_model', { sessionId, modelId: options.model });
    }
  }

  private async _requestSoft(method: string, params: unknown): Promise<void> {
    try {
      await this._request(method, params);
    } catch (err) {
      this._outputChannel.appendLine(`[ACP WARN] ${method} failed: ${formatError(err)}`);
    }
  }

  private _request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (!this._proc?.stdin) return Promise.reject(new Error('ACP process is not running.'));
    const id = this._nextId++;
    const message: AcpMessage = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Timed out waiting for ${method} response.`));
      }, timeoutMs);
      this._pending.set(id, { method, resolve, reject, timeout });
      this._write(message);
    });
  }

  private _notify(method: string, params: unknown): void {
    this._write({ jsonrpc: '2.0', method, params });
  }

  private _write(message: AcpMessage): void {
    if (!this._proc?.stdin) return;
    this._proc.stdin.write(`${JSON.stringify(message)}\n`);
    this._outputChannel.appendLine(`[ACP SEND] ${message.method ?? 'response'} id=${message.id ?? '(none)'}`);
  }

  private _handleStdoutLine(line: string): void {
    const msg = parseAcpMessage(line);
    if (!msg) {
      if (line.trim()) this._outputChannel.appendLine(`[ACP NOISE] ${line.trim().slice(0, 160)}`);
      return;
    }
    this._outputChannel.appendLine(`[ACP RECV] ${line.slice(0, 180)}`);

    if (typeof msg.id === 'number' && this._pending.has(msg.id)) {
      const pending = this._pending.get(msg.id)!;
      this._pending.delete(msg.id);
      clearTimeout(pending.timeout);
      if (msg.error) {
        pending.reject(new Error(`${pending.method}: ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (msg.method === 'session/update') {
      for (const adapted of adaptAcpSessionUpdate(msg.params)) {
        this._emitAdapted(adapted);
      }
      return;
    }

    if (msg.method === 'available_commands_update') {
      const adapted = adaptAcpAvailableCommandsUpdate(msg.params);
      if (adapted) this._emitAdapted(adapted);
      return;
    }

    if (msg.method === 'session/request_permission') {
      this._handlePermissionRequest(msg);
      return;
    }

    if (msg.id !== undefined) {
      this._write({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Unsupported client method: ${msg.method ?? '(unknown)'}` },
      });
    }
  }

  private _handlePermissionRequest(msg: AcpMessage): void {
    if (msg.id === undefined) return;
    const permissionMode = this._active?.permissionMode ?? 'ask';

    if (permissionMode === 'yolo') {
      // Auto-accept in yolo mode, but only when an explicit `allow_once` option is
      // offered. If it is absent, fall through to the UI rather than silently
      // dropping the request or auto-granting something the user never saw.
      const optionId = selectAcpPermissionOption(msg.params, 'yolo');
      if (optionId) {
        this._emitAdapted({
          type: 'tool_use',
          name: readNestedString(msg.params, ['toolCall', 'title']) ?? 'permission request',
        });
        this._write({
          jsonrpc: '2.0',
          id: msg.id,
          result: buildAcpSelectedPermissionResult(optionId),
        });
        return;
      }
    }

    // Ask mode (or yolo with no safe auto-approve option): emit permission request
    // to UI for user decision.
    const toolName = readNestedString(msg.params, ['toolCall', 'title']) ?? 'tool';
    const toolArgs = formatToolInput(readNestedValue(msg.params, ['toolCall', 'input']));
    const options: Array<{ optionId: string; label: string; kind?: string }> = [];
    const rawOptions = (msg.params as { options?: unknown })?.options;
    if (Array.isArray(rawOptions)) {
      for (const opt of rawOptions) {
        if (opt && typeof opt === 'object') {
          const o = opt as Record<string, unknown>;
          if (typeof o.optionId === 'string') {
            options.push({
              optionId: o.optionId,
              label: typeof o.label === 'string' ? o.label : o.optionId,
              kind: typeof o.kind === 'string' ? o.kind : undefined,
            });
          }
        }
      }
    }

    this._emitAdapted({
      type: 'permission_request',
      toolName,
      args: toolArgs ?? undefined,
      options,
      messageId: msg.id,
    });
  }

  respondPermission(messageId: number | string, optionId: string): void {
    this._write({
      jsonrpc: '2.0',
      id: messageId,
      result: buildAcpSelectedPermissionResult(optionId),
    });
  }

  private _emitAdapted(parsed: unknown): void {
    const line = JSON.stringify(parsed);
    if (this._active) {
      this._active.onChunk(line, parsed);
    } else {
      this._discovery?.onChunk(line, parsed);
    }
  }

  private _rejectPending(err: Error): void {
    for (const [id, pending] of this._pending) {
      clearTimeout(pending.timeout);
      pending.reject(err);
      this._pending.delete(id);
    }
  }

  private _terminateProcess(): void {
    if (!this._proc) return;
    const pid = this._proc.pid;
    this._terminating = true;
    this._rejectPending(new Error('ACP process was terminated.'));
    if (pid !== undefined) {
      this._terminatingPids.add(pid);
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/f', '/t']);
      } else {
        this._proc.kill('SIGTERM');
      }
    }
    this._proc = null;
    this._active = null;
    this._promptInFlight = false;
  }
}

function getAcpSpawnCommand(geminiPath: string): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    const configuredPath = geminiPath.trim();
    if (configuredPath.toLowerCase().endsWith('.js')) {
      return { command: process.execPath, args: [configuredPath, '--acp'] };
    }
    return { command: process.execPath, args: [getDefaultWindowsBundlePath(), '--acp'] };
  }
  return { command: geminiPath.trim() || 'gemini', args: ['--acp'] };
}

function getAcpCliUnavailableMessage(geminiPath: string): string | null {
  if (process.platform === 'win32') {
    const bundlePath = geminiPath.trim().toLowerCase().endsWith('.js')
      ? geminiPath.trim()
      : getDefaultWindowsBundlePath();
    return fs.existsSync(bundlePath)
      ? null
      : `Gemini CLI ACP bundle was not found at "${bundlePath}". Install @google/gemini-cli globally, or set CalmUI: Gemini Path to the full gemini.js bundle path.`;
  }

  const configuredPath = geminiPath.trim() || 'gemini';
  if (configuredPath.includes('/') || configuredPath.includes('\\')) {
    return fs.existsSync(configuredPath)
      ? null
      : `Gemini CLI was not found at "${configuredPath}".`;
  }

  const result = spawnSync('command', ['-v', configuredPath], {
    encoding: 'utf-8',
    shell: true,
    windowsHide: true,
  });
  return result.status === 0 ? null : `Gemini CLI was not found on PATH as "${configuredPath}".`;
}

function getDefaultWindowsBundlePath(): string {
  const npmPrefix = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '';
  return path.join(npmPrefix, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
}

function getGeminiSpawnEnv(): NodeJS.ProcessEnv {
  const config = vscode.workspace.getConfiguration('calmui');
  const useVertexAI = config.get<boolean>('useVertexAI', true);
  const gcpProject = config.get<string>('googleCloudProject', '').trim();
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'dumb' };
  if (useVertexAI) {
    env.GOOGLE_GENAI_USE_VERTEXAI = 'true';
    env.GEMINI_API_KEY = '';
    env.GOOGLE_API_KEY = '';
    if (gcpProject) env.GOOGLE_CLOUD_PROJECT = gcpProject;
  }
  return env;
}

function buildAcpPrompt(prompt: string, options: GeminiSendOptions): unknown[] {
  // Phase 39 W2: prepend the locked `[Local mode]` / `[Search mode]` prefix
  // onto the first text part based on the per-turn search mode.
  const prefixedText = applySearchPrefix(prompt, options.searchMode);
  const parts: unknown[] = [{ type: 'text', text: prefixedText }];

  // Phase 39 W2: when `attachments` is present it is the source of truth.
  // Each `AttachmentChip` kind maps to a typed ACP content block. The
  // legacy `images` array is only consulted when `attachments` is absent
  // (deprecation bridge — avoids double-sending).
  const chips = options.attachments;
  if (chips && chips.length > 0) {
    for (const chip of chips) {
      switch (chip.kind) {
        case 'image':
          parts.push({
            type: 'image',
            mimeType: chip.mimeType,
            data: chip.data,
            uri: chip.name,
          });
          break;
        case 'fileRef':
          parts.push({
            type: 'resource_link',
            uri: chip.uri,
            name: chip.name,
            mimeType: chip.mimeType,
          });
          break;
        case 'pdf':
          parts.push({
            type: 'resource',
            resource: {
              uri: chip.uri,
              mimeType: 'application/pdf',
              blob: chip.data,
            },
          });
          break;
        case 'unsupported':
          // Defensive: ChatPanelProvider rejects upstream, so this should
          // never happen. If it does, fail loud rather than silently.
          throw new Error(
            'Unsupported attachment reached buildAcpPrompt — should have been rejected at dispatch',
          );
        default: {
          const _exhaustive: never = chip;
          void _exhaustive;
        }
      }
    }
  } else {
    // Legacy bridge: process `images` only when `attachments` is empty.
    for (const image of options.images ?? []) {
      parts.push({
        type: 'image',
        mimeType: image.mimeType,
        data: image.data,
        uri: image.name,
      });
    }
  }

  const context = options.context;
  const activeFile = context?.activeFile;
  if (!activeFile?.text) return parts;

  parts.push({
    type: 'resource',
    resource: {
      uri: activeFile.uri,
      mimeType: 'text/plain',
      text: [
        `Path: ${activeFile.path}`,
        activeFile.languageId ? `Language: ${activeFile.languageId}` : '',
        activeFile.cursor ? `Cursor: ${activeFile.cursor.line}:${activeFile.cursor.character}` : '',
        activeFile.selection ? `Selection:\n${activeFile.selection}` : '',
        'Content:',
        activeFile.text,
      ].filter(Boolean).join('\n'),
    },
  });
  return parts;
}

function readNativeSessions(value: unknown): ChatSessionSummary[] {
  if (!value || typeof value !== 'object') return [];
  const raw = (value as Record<string, unknown>).sessions;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry): ChatSessionSummary | null => {
      if (!entry || typeof entry !== 'object') return null;
      const obj = entry as Record<string, unknown>;
      const id = firstNonEmptyString(obj.sessionId, obj.id);
      if (!id) return null;
      const title = firstNonEmptyString(obj.title, obj.displayName, obj.name) ?? `Session ${id.slice(0, 8)}`;
      const createdAt = firstNonEmptyString(obj.createdAt, obj.startTime, obj.updatedAt) ?? new Date().toISOString();
      const updatedAt = firstNonEmptyString(obj.updatedAt, obj.lastUpdated);
      const messageCount = typeof obj.messageCount === 'number' ? obj.messageCount : 0;
      return { id, title, createdAt, updatedAt: updatedAt ?? undefined, messageCount, native: true };
    })
    .filter((session): session is ChatSessionSummary => session !== null);
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function readString(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function readNestedString(value: unknown, keys: string[]): string | null {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' && current.trim() ? current.trim() : null;
}

function readNestedValue(value: unknown, keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

// Tool input may be a plain string or a structured object. Render objects as JSON
// so the permission card never shows a blank description for a non-string payload.
function formatToolInput(input: unknown): string | undefined {
  if (typeof input === 'string') {
    return input.trim() || undefined;
  }
  if (input && typeof input === 'object') {
    try {
      return JSON.stringify(input);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
