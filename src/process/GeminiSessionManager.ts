import * as vscode from 'vscode';
import { AcpProcessExitInfo, GeminiProcessAcp } from './GeminiProcessAcp';
import {
  DEFAULT_MODEL_OPTIONS,
  DEFAULT_SLASH_COMMANDS,
  type ChatState,
  type ChatStatus,
  type ConnectionStatus,
} from '../shared/messages';

export interface SessionHandle {
  readonly sessionId: string;
  chatState: ChatState;
  generationId: number;
  queue: Array<{ id: string; text: string }>;
  activeAssistantId: string | null;
  activeToolId: string | null;
  stallTimer: NodeJS.Timeout | null;
  status: 'active' | 'cancelled' | 'destroyed';
}

export type RecoveryState =
  | { status: 'ready' }
  | { status: 'reconnecting'; attempt: number; hadActivePrompt: boolean }
  | { status: 'failed'; message: string; hadActivePrompt: boolean };

export type HealthState =
  | { status: 'connected' }
  | { status: 'disconnected'; message: string }
  | { status: 'error'; message: string };

function makeInitialChatState(): ChatState {
  return {
    status: 'idle',
    connection: 'connected',
    messages: [],
    permissionMode: 'ask',
    model: 'gemini-2.5-pro',
    availableModels: DEFAULT_MODEL_OPTIONS,
    availableCommands: DEFAULT_SLASH_COMMANDS,
    gcloud: { account: null, project: null },
    // Phase 39 W2: default per-turn search mode is `local`.
    searchMode: 'local',
  };
}

export class GeminiSessionManager implements vscode.Disposable {
  private readonly _process: GeminiProcessAcp;
  private readonly _sessions = new Map<string, SessionHandle>();
  private _activeSessionId: string | null = null;
  private _hasObservedRunningProcess = false;
  private _recoveryTimer: NodeJS.Timeout | null = null;
  private _heartbeatTimer: NodeJS.Timeout | null = null;
  private _crashTimestamps: number[] = [];
  private _disposed = false;
  private _onRecoveryStateChange?: (state: RecoveryState) => void;
  private _onHealthStateChange?: (state: HealthState) => void;
  private static readonly INITIAL_RESTART_DELAY_MS = 1_000;
  private static readonly MAX_RESTART_DELAY_MS = 15_000;
  private static readonly HEARTBEAT_INTERVAL_MS = 30_000;
  private static readonly CRASH_WINDOW_MS = 60_000;
  private static readonly MAX_CRASHES_PER_WINDOW = 3;

  constructor(private readonly _outputChannel: vscode.OutputChannel) {
    this._process = new GeminiProcessAcp(_outputChannel);
    this._process.setOnProcessExit((info) => this._handleProcessExit(info));
  }

  get process(): GeminiProcessAcp {
    return this._process;
  }

  get activeSessionId(): string | null {
    return this._activeSessionId;
  }

  setRecoveryStateCallback(cb: (state: RecoveryState) => void): void {
    this._onRecoveryStateChange = cb;
  }

  setHealthStateCallback(cb: (state: HealthState) => void): void {
    this._onHealthStateChange = cb;
    this._startHeartbeat();
  }

  get connectionStatus(): ConnectionStatus {
    return this._process.isRunning() ? 'connected' : 'disconnected';
  }

  setMcpServers(servers: Parameters<GeminiProcessAcp['setMcpServers']>[0]): void {
    this._process.setMcpServers(servers);
  }

  async createSession(cwd: string): Promise<SessionHandle> {
    const { sessionId, adapted } = await this._process.createSession(cwd);
    this._hasObservedRunningProcess = true;
    this._outputChannel.appendLine(`[SESSION MGR] created session=${sessionId}`);

    const handle: SessionHandle = {
      sessionId,
      chatState: makeInitialChatState(),
      generationId: 0,
      queue: [],
      activeAssistantId: null,
      activeToolId: null,
      stallTimer: null,
      status: 'active',
    };

    // Apply adapted session info (available modes, models) to initial state
    if (adapted && typeof adapted === 'object') {
      const info = adapted as Record<string, unknown>;
      if (info.type === 'init') {
        handle.chatState = {
          ...handle.chatState,
          session: {
            resolvedModel: typeof info.model === 'string' ? info.model : undefined,
            sessionId,
          },
        };
      }
    }

    this._sessions.set(sessionId, handle);
    this._activeSessionId = sessionId;
    return handle;
  }

  async listNativeSessions(cwd: string) {
    return this._process.listSessions(cwd);
  }

  async loadSession(cwd: string, sessionId: string): Promise<SessionHandle> {
    const { adapted } = await this._process.loadSession(cwd, sessionId);
    this._hasObservedRunningProcess = true;
    this._outputChannel.appendLine(`[SESSION MGR] loaded session=${sessionId}`);

    const handle: SessionHandle = {
      sessionId,
      chatState: makeInitialChatState(),
      generationId: 0,
      queue: [],
      activeAssistantId: null,
      activeToolId: null,
      stallTimer: null,
      status: 'active',
    };

    if (adapted && typeof adapted === 'object') {
      const info = adapted as Record<string, unknown>;
      if (info.type === 'init') {
        handle.chatState = {
          ...handle.chatState,
          session: {
            resolvedModel: typeof info.model === 'string' ? info.model : undefined,
            sessionId,
          },
        };
      }
    }

    this._sessions.set(sessionId, handle);
    this._activeSessionId = sessionId;
    return handle;
  }

  destroySession(sessionId: string): void {
    const handle = this._sessions.get(sessionId);
    if (!handle || handle.status === 'destroyed') return;

    this._outputChannel.appendLine(`[SESSION MGR] destroying session=${sessionId}`);
    handle.status = 'destroyed';

    if (handle.stallTimer) {
      clearInterval(handle.stallTimer);
      handle.stallTimer = null;
    }

    this._process.cancelSession(sessionId);
    this._sessions.delete(sessionId);

    if (this._activeSessionId === sessionId) {
      this._activeSessionId = null;
    }
  }

  getSession(sessionId: string): SessionHandle | null {
    return this._sessions.get(sessionId) ?? null;
  }

  getActiveSession(): SessionHandle | null {
    if (!this._activeSessionId) return null;
    return this._sessions.get(this._activeSessionId) ?? null;
  }

  setActiveSession(sessionId: string): void {
    if (!this._sessions.has(sessionId)) return;
    this._activeSessionId = sessionId;
  }

  get sessionCount(): number {
    return this._sessions.size;
  }

  private _handleProcessExit(info: AcpProcessExitInfo): void {
    this._outputChannel.appendLine(
      `[SESSION MGR] process exited — clearing ${this._sessions.size} session(s)`,
    );
    for (const [id, handle] of this._sessions) {
      handle.status = 'destroyed';
      if (handle.stallTimer) {
        clearInterval(handle.stallTimer);
        handle.stallTimer = null;
      }
    }
    this._sessions.clear();
    this._activeSessionId = null;

    if (this._disposed || info.intentional) return;
    this._scheduleRestart(info.hadActivePrompt);
  }

  private _scheduleRestart(hadActivePrompt: boolean): void {
    const now = Date.now();
    this._crashTimestamps = [...this._crashTimestamps, now]
      .filter((timestamp) => now - timestamp <= GeminiSessionManager.CRASH_WINDOW_MS);

    if (this._crashTimestamps.length >= GeminiSessionManager.MAX_CRASHES_PER_WINDOW) {
      if (this._recoveryTimer) {
        clearTimeout(this._recoveryTimer);
        this._recoveryTimer = null;
      }
      const message = 'Gemini ACP crashed repeatedly. Restart stopped; send a new prompt or reload the window after checking the CalmUI output channel.';
      this._outputChannel.appendLine(`[SESSION MGR] ${message}`);
      this._onRecoveryStateChange?.({ status: 'failed', message, hadActivePrompt });
      return;
    }

    const attempt = this._crashTimestamps.length;
    this._onRecoveryStateChange?.({ status: 'reconnecting', attempt, hadActivePrompt });
    if (this._recoveryTimer) clearTimeout(this._recoveryTimer);
    const restartDelay = GeminiSessionManager._restartBackoffMs(attempt);
    this._outputChannel.appendLine(
      `[SESSION MGR] scheduling restart attempt=${attempt} delay=${restartDelay}ms`,
    );
    this._recoveryTimer = setTimeout(() => {
      this._recoveryTimer = null;
      void this._process.restart()
        .then(() => {
          this._hasObservedRunningProcess = true;
          this._outputChannel.appendLine('[SESSION MGR] ACP process restarted');
          this._onHealthStateChange?.({ status: 'connected' });
          this._onRecoveryStateChange?.({ status: 'ready' });
        })
        .catch((err) => {
          this._outputChannel.appendLine(`[SESSION MGR] restart failed: ${err instanceof Error ? err.message : String(err)}`);
          // Do not record the failure here: _scheduleRestart() appends its own
          // timestamp. Pushing one here too double-counts the attempt against
          // the crash window, tripping the circuit breaker and inflating backoff.
          this._scheduleRestart(hadActivePrompt);
        });
    }, restartDelay);
  }

  private static _restartBackoffMs(attempt: number): number {
    const exponent = Math.max(0, attempt - 1);
    return Math.min(
      GeminiSessionManager.MAX_RESTART_DELAY_MS,
      GeminiSessionManager.INITIAL_RESTART_DELAY_MS * (2 ** exponent),
    );
  }

  private _startHeartbeat(): void {
    if (this._heartbeatTimer || this._disposed) return;
    this._heartbeatTimer = setInterval(() => {
      if (this._disposed) return;
      if (!this._process.isRunning()) {
        if (!this._hasObservedRunningProcess) return;
        this._onHealthStateChange?.({ status: 'disconnected', message: 'Gemini ACP is not running.' });
        return;
      }
      this._hasObservedRunningProcess = true;
      void this._process.ping()
        .then(() => this._onHealthStateChange?.({ status: 'connected' }))
        .catch((err) => this._onHealthStateChange?.({
          status: 'error',
          message: `Gemini ACP heartbeat failed: ${err instanceof Error ? err.message : String(err)}`,
        }));
    }, GeminiSessionManager.HEARTBEAT_INTERVAL_MS);
  }

  dispose(): void {
    this._disposed = true;
    if (this._recoveryTimer) {
      clearTimeout(this._recoveryTimer);
      this._recoveryTimer = null;
    }
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    this._outputChannel.appendLine('[SESSION MGR] disposing');
    for (const [, handle] of this._sessions) {
      if (handle.stallTimer) {
        clearInterval(handle.stallTimer);
        handle.stallTimer = null;
      }
    }
    this._sessions.clear();
    this._activeSessionId = null;
    this._process.dispose();
  }
}
