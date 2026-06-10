import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GeminiSessionManager } from './GeminiSessionManager';
import type { AcpProcessExitInfo } from './GeminiProcessAcp';

// Mock GeminiProcessAcp — it spawns a real child process
vi.mock('./GeminiProcessAcp', () => {
  let sessionCounter = 0;
  class MockGeminiProcessAcp {
    _exitCallback?: (info: AcpProcessExitInfo) => void;
    createSession = vi.fn().mockImplementation(async (cwd: string) => {
      sessionCounter++;
      return { sessionId: `session-${sessionCounter}`, adapted: null };
    });
    cancelSession = vi.fn();
    send = vi.fn();
    kill = vi.fn();
    dispose = vi.fn();
    restart = vi.fn().mockResolvedValue(undefined);
    isRunning = vi.fn().mockReturnValue(true);
    ping = vi.fn().mockResolvedValue(undefined);
    setOnProcessExit = vi.fn().mockImplementation((cb: (info: AcpProcessExitInfo) => void) => {
      this._exitCallback = cb;
    });
    _triggerExit(info: Partial<AcpProcessExitInfo> = {}) {
      this._exitCallback?.({
        code: info.code ?? 1,
        hadActivePrompt: info.hadActivePrompt ?? false,
        intentional: info.intentional ?? false,
      });
    }
  }
  return { GeminiProcessAcp: MockGeminiProcessAcp };
});

function createMockOutputChannel() {
  return { appendLine: vi.fn() } as any;
}

describe('GeminiSessionManager', () => {
  let manager: GeminiSessionManager;
  let outputChannel: any;

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    outputChannel = createMockOutputChannel();
    manager = new GeminiSessionManager(outputChannel);
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  it('createSession returns a SessionHandle with a sessionId', async () => {
    const handle = await manager.createSession('/workspace');
    expect(handle.sessionId).toMatch(/^session-/);
    expect(handle.status).toBe('active');
    expect(handle.generationId).toBe(0);
    expect(handle.queue).toEqual([]);
    expect(handle.chatState.status).toBe('idle');
    expect(handle.chatState.connection).toBe('connected');
    expect(handle.chatState.messages).toEqual([]);
  });

  it('createSession sets the new session as active', async () => {
    const handle = await manager.createSession('/workspace');
    expect(manager.activeSessionId).toBe(handle.sessionId);
  });

  it('createSession called twice produces two distinct sessionIds', async () => {
    const handle1 = await manager.createSession('/workspace');
    const handle2 = await manager.createSession('/workspace');
    expect(handle1.sessionId).not.toBe(handle2.sessionId);
    expect(manager.sessionCount).toBe(2);
  });

  it('destroySession removes the session from the map', async () => {
    const handle = await manager.createSession('/workspace');
    expect(manager.getSession(handle.sessionId)).toBeTruthy();
    manager.destroySession(handle.sessionId);
    expect(manager.getSession(handle.sessionId)).toBeNull();
    expect(manager.sessionCount).toBe(0);
  });

  it('destroySession sends cancelSession to the process', async () => {
    const handle = await manager.createSession('/workspace');
    manager.destroySession(handle.sessionId);
    expect(manager.process.cancelSession).toHaveBeenCalledWith(handle.sessionId);
  });

  it('destroySession is idempotent — double destroy is a no-op', async () => {
    const handle = await manager.createSession('/workspace');
    manager.destroySession(handle.sessionId);
    manager.destroySession(handle.sessionId); // should not throw
    expect(manager.sessionCount).toBe(0);
  });

  it('destroySession clears activeSessionId when destroying the active session', async () => {
    const handle = await manager.createSession('/workspace');
    expect(manager.activeSessionId).toBe(handle.sessionId);
    manager.destroySession(handle.sessionId);
    expect(manager.activeSessionId).toBeNull();
  });

  it('getSession returns null for unknown sessionId', () => {
    expect(manager.getSession('nonexistent')).toBeNull();
  });

  it('getActiveSession returns the active session handle', async () => {
    const handle = await manager.createSession('/workspace');
    const active = manager.getActiveSession();
    expect(active).toBe(handle);
  });

  it('getActiveSession returns null when no sessions exist', () => {
    expect(manager.getActiveSession()).toBeNull();
  });

  it('per-session generationId: each session starts at 0 independently', async () => {
    const handle1 = await manager.createSession('/workspace');
    handle1.generationId = 5; // simulate 5 turns
    const handle2 = await manager.createSession('/workspace');
    expect(handle2.generationId).toBe(0);
    expect(handle1.generationId).toBe(5);
  });

  it('process exit clears all sessions from the map', async () => {
    await manager.createSession('/workspace');
    await manager.createSession('/workspace');
    expect(manager.sessionCount).toBe(2);

    // Trigger process exit via the mock
    (manager.process as any)._triggerExit();
    expect(manager.sessionCount).toBe(0);
    expect(manager.activeSessionId).toBeNull();
  });

  it('unexpected process exit schedules an ACP restart', async () => {
    vi.useFakeTimers();
    const recovery = vi.fn();
    manager.setRecoveryStateCallback(recovery);

    (manager.process as any)._triggerExit({ hadActivePrompt: true });

    expect(recovery).toHaveBeenCalledWith({
      status: 'reconnecting',
      attempt: 1,
      hadActivePrompt: true,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(manager.process.restart).toHaveBeenCalled();
    expect(recovery).toHaveBeenLastCalledWith({ status: 'ready' });
  });

  it('reports connected health after a successful heartbeat ping', async () => {
    vi.useFakeTimers();
    const health = vi.fn();
    manager.setHealthStateCallback(health);

    await vi.advanceTimersByTimeAsync(30000);

    expect(manager.process.ping).toHaveBeenCalled();
    expect(health).toHaveBeenLastCalledWith({ status: 'connected' });
  });

  it('reports disconnected health when the ACP process is not running', async () => {
    vi.useFakeTimers();
    const health = vi.fn();
    (manager.process as any).isRunning.mockReturnValue(false);
    manager.setHealthStateCallback(health);

    await vi.advanceTimersByTimeAsync(30000);

    expect(manager.process.ping).not.toHaveBeenCalled();
    expect(health).toHaveBeenLastCalledWith({
      status: 'disconnected',
      message: 'Gemini ACP is not running.',
    });
  });

  it('reports error health when heartbeat ping fails', async () => {
    vi.useFakeTimers();
    const health = vi.fn();
    (manager.process as any).ping.mockRejectedValueOnce(new Error('no pong'));
    manager.setHealthStateCallback(health);

    await vi.advanceTimersByTimeAsync(30000);

    expect(health).toHaveBeenLastCalledWith({
      status: 'error',
      message: 'Gemini ACP heartbeat failed: no pong',
    });
  });

  it('intentional process exit does not schedule recovery', async () => {
    vi.useFakeTimers();
    const recovery = vi.fn();
    manager.setRecoveryStateCallback(recovery);

    (manager.process as any)._triggerExit({ intentional: true });
    await vi.advanceTimersByTimeAsync(1000);

    expect(manager.process.restart).not.toHaveBeenCalled();
    expect(recovery).not.toHaveBeenCalled();
  });

  it('stops retrying after repeated crashes in the crash window', () => {
    vi.useFakeTimers();
    const recovery = vi.fn();
    manager.setRecoveryStateCallback(recovery);

    (manager.process as any)._triggerExit();
    (manager.process as any)._triggerExit();
    (manager.process as any)._triggerExit();

    expect(recovery).toHaveBeenLastCalledWith({
      status: 'failed',
      message: expect.stringContaining('crashed repeatedly'),
      hadActivePrompt: false,
    });
  });

  it('dispose clears sessions and disposes the process', async () => {
    await manager.createSession('/workspace');
    manager.dispose();
    expect(manager.sessionCount).toBe(0);
    expect(manager.process.dispose).toHaveBeenCalled();
  });
});
