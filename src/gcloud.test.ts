import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('gcloud resolution', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });

  afterEach(() => {
    vi.doUnmock('child_process');
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('prefers where.exe results on Windows', async () => {
    const spawnSync = vi.fn().mockReturnValue({
      status: 0,
      stdout: 'C:\\Users\\test\\.local\\bin\\gcloud.cmd\r\n',
      stderr: '',
    });
    vi.doMock('child_process', () => ({
      spawnSync,
      spawn: vi.fn(),
    }));

    const mod = await import('./gcloud');
    const resolved = mod.resolveGcloudCommand({ USERPROFILE: 'C:\\Users\\test' });

    expect(spawnSync).toHaveBeenCalledWith('where.exe', ['gcloud'], expect.any(Object));
    expect(resolved).toBe('C:\\Users\\test\\.local\\bin\\gcloud.cmd');
  });

  it('falls back to the common user-local install path when PATH lookup misses', async () => {
    vi.doMock('child_process', () => ({
      spawnSync: vi.fn().mockReturnValue({
        status: 1,
        stdout: '',
        stderr: '',
      }),
      spawn: vi.fn(),
    }));

    const mod = await import('./gcloud');
    const resolved = mod.resolveGcloudCommand({ USERPROFILE: 'C:\\Users\\test' });

    expect(resolved).toBe(path.join('C:\\Users\\test', '.local', 'bin', 'gcloud.cmd'));
    expect(mod.getWindowsGcloudCandidates({ USERPROFILE: 'C:\\Users\\test' })[0]).toBe(resolved);
  });
});
