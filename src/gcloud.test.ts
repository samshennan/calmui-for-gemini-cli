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
    vi.doUnmock('fs');
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

  it('normalizes an extensionless where.exe result to gcloud.cmd when present', async () => {
    const spawnSync = vi.fn().mockReturnValue({
      status: 0,
      stdout: 'C:\\Users\\test\\AppData\\Local\\Google\\CloudSDK\\google-cloud-sdk\\bin\\gcloud\r\n',
      stderr: '',
    });
    vi.doMock('child_process', () => ({
      spawnSync,
      spawn: vi.fn(),
    }));
    vi.doMock('fs', () => ({
      existsSync: vi.fn((file: string) => file.endsWith('gcloud.cmd')),
    }));

    const mod = await import('./gcloud');
    const resolved = mod.resolveGcloudCommand({ USERPROFILE: 'C:\\Users\\test' });

    expect(resolved).toBe('C:\\Users\\test\\AppData\\Local\\Google\\CloudSDK\\google-cloud-sdk\\bin\\gcloud.cmd');
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
    const userLocal = path.join('C:\\Users\\test', '.local', 'bin', 'gcloud.cmd');
    vi.doMock('fs', () => ({
      existsSync: vi.fn((file: string) => file === userLocal),
    }));

    const mod = await import('./gcloud');
    const resolved = mod.resolveGcloudCommand({ USERPROFILE: 'C:\\Users\\test' });

    expect(resolved).toBe(userLocal);
    expect(mod.getWindowsGcloudCandidates({ USERPROFILE: 'C:\\Users\\test' })[0]).toBe(resolved);
  });

  it('skips candidate paths that do not exist on disk', async () => {
    vi.doMock('child_process', () => ({
      spawnSync: vi.fn().mockReturnValue({
        status: 1,
        stdout: '',
        stderr: '',
      }),
      spawn: vi.fn(),
    }));
    const cloudSdk = path.join(
      'C:\\Users\\test\\AppData\\Local', 'Google', 'CloudSDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd',
    );
    vi.doMock('fs', () => ({
      existsSync: vi.fn((file: string) => file === cloudSdk),
    }));

    const mod = await import('./gcloud');
    const resolved = mod.resolveGcloudCommand({
      USERPROFILE: 'C:\\Users\\test',
      LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
    });

    expect(resolved).toBe(cloudSdk);
  });

  it('returns null when no candidate exists anywhere', async () => {
    vi.doMock('child_process', () => ({
      spawnSync: vi.fn().mockReturnValue({
        status: 1,
        stdout: '',
        stderr: '',
      }),
      spawn: vi.fn(),
    }));
    vi.doMock('fs', () => ({
      existsSync: vi.fn(() => false),
    }));

    const mod = await import('./gcloud');
    const resolved = mod.resolveGcloudCommand({ USERPROFILE: 'C:\\Users\\test' });

    expect(resolved).toBeNull();
  });

  it('includes the CloudSDK user install path variant used by the Windows installer', async () => {
    vi.doMock('child_process', () => ({
      spawnSync: vi.fn().mockReturnValue({
        status: 1,
        stdout: '',
        stderr: '',
      }),
      spawn: vi.fn(),
    }));

    const mod = await import('./gcloud');
    const candidates = mod.getWindowsGcloudCandidates({
      USERPROFILE: 'C:\\Users\\test',
      LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
    });

    expect(candidates).toContain(
      path.join('C:\\Users\\test\\AppData\\Local', 'Google', 'CloudSDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd'),
    );
  });

  it('builds Windows spawn args without quoting the command path', async () => {
    vi.doMock('child_process', () => ({
      spawnSync: vi.fn(),
      spawn: vi.fn(),
    }));

    const mod = await import('./gcloud');
    const commandArgs = mod.buildWindowsSpawnArgs(
      'C:\\Users\\test\\.local\\bin\\gcloud.cmd',
      ['auth', 'application-default', 'print-access-token'],
    );

    expect(commandArgs).toEqual([
      '/d',
      '/s',
      '/c',
      'C:\\Users\\test\\.local\\bin\\gcloud.cmd',
      'auth',
      'application-default',
      'print-access-token',
    ]);
  });

  it('preserves Windows arguments with spaces as distinct argv entries', async () => {
    vi.doMock('child_process', () => ({
      spawnSync: vi.fn(),
      spawn: vi.fn(),
    }));

    const mod = await import('./gcloud');
    const commandArgs = mod.buildWindowsSpawnArgs(
      'C:\\Program Files\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd',
      ['config', 'set', 'project', 'My Project'],
    );

    expect(commandArgs).toEqual([
      '/d',
      '/s',
      '/c',
      'C:\\Program Files\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd',
      'config',
      'set',
      'project',
      'My Project',
    ]);
  });
});
