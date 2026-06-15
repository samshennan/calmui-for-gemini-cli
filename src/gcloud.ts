import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface GcloudCommandResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export async function runGcloudCommand(
  args: string[],
  timeout: number,
): Promise<GcloudCommandResult> {
  const command = resolveGcloudCommand(process.env);
  if (!command) {
    return {
      ok: false,
      status: null,
      stdout: '',
      stderr: '',
      error: 'gcloud was not found on PATH or in common install locations.',
    };
  }

  if (process.platform === 'win32') {
    return runWindowsCommand(command, args, timeout);
  }

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({
        ok: false,
        status: null,
        stdout,
        stderr,
        error: `Command timed out after ${timeout}ms.`,
      });
    }, timeout);

    child.stdout.on('data', (chunk: Buffer | string) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk: Buffer | string) => { stderr += String(chunk); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        status: null,
        stdout,
        stderr,
        error: err.message,
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        status: code,
        stdout,
        stderr,
      });
    });
  });
}

export function runGcloudCommandSync(
  args: string[],
  timeout: number,
): GcloudCommandResult {
  const command = resolveGcloudCommand(process.env);
  if (!command) {
    return {
      ok: false,
      status: null,
      stdout: '',
      stderr: '',
      error: 'gcloud was not found on PATH or in common install locations.',
    };
  }

  if (process.platform === 'win32') {
    const result = spawnSync('cmd.exe', buildWindowsSpawnArgs(command, args), {
      encoding: 'utf-8',
      windowsHide: true,
      timeout,
    });
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error?.message,
    };
  }

  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    windowsHide: true,
    timeout,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message,
  };
}

export function resolveGcloudCommand(env: NodeJS.ProcessEnv): string | null {
  if (process.platform !== 'win32') return 'gcloud';

  const discovered = findGcloudOnWindowsPath();
  if (discovered) return normalizeWindowsGcloudPath(discovered);

  for (const candidate of getWindowsGcloudCandidates(env)) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function getWindowsGcloudCandidates(env: NodeJS.ProcessEnv): string[] {
  const userProfile = env.USERPROFILE || env.HOME || '';
  const localAppData = env.LOCALAPPDATA || (userProfile ? path.join(userProfile, 'AppData', 'Local') : '');
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

  return [
    userProfile ? path.join(userProfile, '.local', 'bin', 'gcloud.cmd') : '',
    localAppData ? path.join(localAppData, 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd') : '',
    localAppData ? path.join(localAppData, 'Google', 'CloudSDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd') : '',
    programFiles ? path.join(programFiles, 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd') : '',
    programFilesX86 ? path.join(programFilesX86, 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd') : '',
  ].filter(Boolean);
}

function findGcloudOnWindowsPath(): string | null {
  for (const probe of ['gcloud', 'gcloud.cmd', 'gcloud.exe']) {
    const result = spawnSync('where.exe', [probe], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 3000,
    });
    if (result.status !== 0) continue;
    const match = (result.stdout ?? '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean);
    if (match) return match;
  }
  return null;
}

function normalizeWindowsGcloudPath(value: string): string {
  const trimmed = value.trim();
  if (/\.(cmd|exe|bat|ps1)$/i.test(trimmed)) return trimmed;
  const cmdPath = `${trimmed}.cmd`;
  return fs.existsSync(cmdPath) ? cmdPath : trimmed;
}

function runWindowsCommand(
  command: string,
  args: string[],
  timeout: number,
): Promise<GcloudCommandResult> {
  return new Promise((resolve) => {
    const child = spawn('cmd.exe', buildWindowsSpawnArgs(command, args), {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // child.kill() only reaps the cmd.exe wrapper, orphaning the gcloud.cmd
      // -> python subtree it spawned. Tree-kill by pid so the whole process
      // group is terminated (same pattern as the ACP process cleanup).
      if (child.pid !== undefined) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true });
      } else {
        child.kill();
      }
      resolve({
        ok: false,
        status: null,
        stdout,
        stderr,
        error: `Command timed out after ${timeout}ms.`,
      });
    }, timeout);

    child.stdout.on('data', (chunk: Buffer | string) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk: Buffer | string) => { stderr += String(chunk); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        status: null,
        stdout,
        stderr,
        error: err.message,
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        status: code,
        stdout,
        stderr,
      });
    });
  });
}

export function buildWindowsSpawnArgs(command: string, args: string[]): string[] {
  return ['/d', '/s', '/c', command, ...args];
}
