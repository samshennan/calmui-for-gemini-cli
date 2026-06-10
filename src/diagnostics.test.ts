import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDiagnosticsReport, probeSearchGrounding } from './diagnostics';

vi.mock('vscode', () => ({
  window: {
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  },
}));

describe('buildDiagnosticsReport', () => {
  it('normalizes checks and preserves one fix action per failed check', () => {
    const report = buildDiagnosticsReport([
      {
        id: 'extension',
        label: 'Extension',
        ok: true,
        detail: 'version=1.4.0 vscode=1.115.0',
      },
      {
        id: 'transport',
        label: 'Transport',
        ok: false,
        detail: 'Legacy stream-json fallback is enabled',
        fix: 'Enable CalmUI: Use ACP.',
        action: 'openVSCodeSettings',
      },
      {
        id: 'workspace',
        label: 'Workspace',
        ok: false,
        detail: 'No workspace folder is open',
      },
      {
        id: 'vertex-adc',
        label: 'Vertex ADC',
        ok: false,
        detail: 'gcloud auth missing',
        fix: 'Run gcloud auth application-default login, then retry diagnostics.',
        action: 'refreshGcloud',
      },
    ]);

    expect(report.passed).toBe(1);
    expect(report.total).toBe(4);
    expect(report.checks.map(check => check.status)).toEqual(['pass', 'warn', 'warn', 'fail']);
    expect(report.checks[1].action).toBe('openVSCodeSettings');
    expect(report.checks[2].action).toBe('runDiagnostics');
    expect(report.checks[3].action).toBe('refreshGcloud');
  });

  it('maps a non-ok search-grounding check to warn (feature toggle, not blocker)', () => {
    const report = buildDiagnosticsReport([
      {
        id: 'search-grounding',
        label: 'Search grounding',
        ok: false,
        detail: 'google_web_search excluded',
      },
    ]);
    expect(report.checks[0].status).toBe('warn');
  });
});

describe('probeSearchGrounding', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'calmui-sg-probe-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  function writeSettings(dir: string, contents: string): void {
    const settingsDir = path.join(dir, '.gemini');
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, 'settings.json'), contents, 'utf-8');
  }

  it('returns ok when both settings.json files are missing (defaults apply)', () => {
    const homeDir = path.join(tmpRoot, 'home');
    fs.mkdirSync(homeDir, { recursive: true });
    const result = probeSearchGrounding({ homeDir, capabilities: null });
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/[Dd]efaults apply/);
  });

  it('returns not-ok when google_web_search is in tools.exclude in user settings', () => {
    const homeDir = path.join(tmpRoot, 'home');
    fs.mkdirSync(homeDir, { recursive: true });
    writeSettings(homeDir, JSON.stringify({ tools: { exclude: ['google_web_search'] } }));
    const result = probeSearchGrounding({ homeDir, capabilities: null });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/google_web_search/);
    expect(result.fix).toMatch(/Remove `google_web_search`/);
    expect(result.action).toBe('openGeminiSettings');
  });

  it('lets workspace settings override user settings (workspace excludes wins)', () => {
    const homeDir = path.join(tmpRoot, 'home');
    const wsRoot = path.join(tmpRoot, 'ws');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(wsRoot, { recursive: true });
    // User settings allow search; workspace excludes it.
    writeSettings(homeDir, JSON.stringify({ tools: {} }));
    writeSettings(wsRoot, JSON.stringify({ tools: { exclude: ['google_web_search'] } }));
    const result = probeSearchGrounding({ homeDir, workspaceRoot: wsRoot, capabilities: null });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain(path.join(wsRoot, '.gemini', 'settings.json'));
  });

  it('returns not-ok when sandboxNetworkAccess is false', () => {
    const homeDir = path.join(tmpRoot, 'home');
    fs.mkdirSync(homeDir, { recursive: true });
    writeSettings(homeDir, JSON.stringify({ tools: { sandboxNetworkAccess: false } }));
    const result = probeSearchGrounding({ homeDir, capabilities: null });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/sandboxNetworkAccess/);
  });

  it('does NOT throw on malformed JSON; surfaces a "could not verify" warn-style detail', () => {
    const homeDir = path.join(tmpRoot, 'home');
    fs.mkdirSync(homeDir, { recursive: true });
    writeSettings(homeDir, '{ this is not json');
    const result = probeSearchGrounding({ homeDir, capabilities: null });
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/[Cc]ould not verify/);
  });

  it('accepts the legacy `coreTools` alias for tools.exclude', () => {
    const homeDir = path.join(tmpRoot, 'home');
    fs.mkdirSync(homeDir, { recursive: true });
    writeSettings(homeDir, JSON.stringify({ coreTools: ['google_web_search'] }));
    const result = probeSearchGrounding({ homeDir, capabilities: null });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/google_web_search/);
  });
});

// Phase 39 W5 — fully-mocked probeSearchGrounding tests.
// The fixtures above use the real filesystem in a tmp dir; these tests use
// `vi.mock('fs')` / `vi.mock('os')` instead so they run without any disk I/O
// and assert exactly which path was read.
describe('probeSearchGrounding (mocked fs/os)', () => {
  const readFileSyncMock = vi.fn();
  const homedirMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    readFileSyncMock.mockReset();
    homedirMock.mockReset();
    homedirMock.mockReturnValue('C:\\Users\\test');
    vi.doMock('fs', () => ({
      readFileSync: readFileSyncMock,
      // Other diagnostics code paths use these but probeSearchGrounding only
      // exercises readFileSync. Stub the rest so the module loads cleanly.
      existsSync: vi.fn().mockReturnValue(false),
      mkdtempSync: vi.fn(),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      rmSync: vi.fn(),
    }));
    vi.doMock('os', () => ({
      homedir: homedirMock,
      tmpdir: vi.fn().mockReturnValue('/tmp'),
    }));
  });

  afterEach(() => {
    vi.doUnmock('fs');
    vi.doUnmock('os');
  });

  async function loadProbe() {
    const mod = await import('./diagnostics');
    return mod.probeSearchGrounding;
  }

  function enoent(): NodeJS.ErrnoException {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    return err;
  }

  it('returns ok when both files are missing (ENOENT) — defaults apply', async () => {
    readFileSyncMock.mockImplementation(() => { throw enoent(); });
    const probe = await loadProbe();
    const result = probe({ homeDir: 'C:\\Users\\test', capabilities: null });
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/[Dd]efaults apply/);
  });

  it('flags user settings.json when tools.exclude contains google_web_search', async () => {
    readFileSyncMock.mockImplementation((file: string) => {
      if (file.includes('Users') && file.endsWith('settings.json')) {
        return JSON.stringify({ tools: { exclude: ['google_web_search'] } });
      }
      throw enoent();
    });
    const probe = await loadProbe();
    const result = probe({ homeDir: 'C:\\Users\\test', capabilities: null });
    expect(result.ok).toBe(false);
    expect(result.action).toBe('openGeminiSettings');
    expect(result.fix).toMatch(/Remove `google_web_search`/);
    expect(result.detail).toMatch(/google_web_search/);
  });

  it('flags workspace settings even when user settings are clean (workspace overrides user)', async () => {
    const wsRoot = 'D:\\workspace';
    readFileSyncMock.mockImplementation((file: string) => {
      if (file.includes('workspace')) {
        return JSON.stringify({ tools: { exclude: ['google_web_search'] } });
      }
      if (file.includes('Users')) {
        return JSON.stringify({ tools: { exclude: [] } });
      }
      throw enoent();
    });
    const probe = await loadProbe();
    const result = probe({
      homeDir: 'C:\\Users\\test',
      workspaceRoot: wsRoot,
      capabilities: null,
    });
    expect(result.ok).toBe(false);
    // Detail names the workspace settings.json, not the user one.
    expect(result.detail).toContain(wsRoot);
    expect(result.detail).toContain('settings.json');
    expect(result.detail).not.toContain('Users\\test');
  });

  it('flags sandboxNetworkAccess: false in user settings', async () => {
    readFileSyncMock.mockImplementation((file: string) => {
      if (file.endsWith('settings.json')) {
        return JSON.stringify({ tools: { sandboxNetworkAccess: false } });
      }
      throw enoent();
    });
    const probe = await loadProbe();
    const result = probe({ homeDir: 'C:\\Users\\test', capabilities: null });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/sandboxNetworkAccess/);
  });

  it('does NOT throw on malformed JSON; reports a "could not verify" warn detail', async () => {
    readFileSyncMock.mockImplementation((file: string) => {
      if (file.endsWith('settings.json')) {
        return '{ this is not json';
      }
      throw enoent();
    });
    const probe = await loadProbe();
    expect(() => probe({ homeDir: 'C:\\Users\\test', capabilities: null })).not.toThrow();
    const result = probe({ homeDir: 'C:\\Users\\test', capabilities: null });
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/[Cc]ould not verify/);
  });

  it('accepts the legacy coreTools alias as a tools.exclude fallback', async () => {
    readFileSyncMock.mockImplementation((file: string) => {
      if (file.endsWith('settings.json')) {
        return JSON.stringify({ coreTools: ['google_web_search'] });
      }
      throw enoent();
    });
    const probe = await loadProbe();
    const result = probe({ homeDir: 'C:\\Users\\test', capabilities: null });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/google_web_search/);
  });

  it('resolves the user settings path under the mocked homedir using path.join', async () => {
    let observedPath = '';
    readFileSyncMock.mockImplementation((file: string) => {
      // First call is the user settings path; capture it for the assertion.
      if (!observedPath) observedPath = file;
      throw enoent();
    });
    const probe = await loadProbe();
    probe({ homeDir: 'C:\\Users\\test', capabilities: null });
    // Use path.join so the test passes on any OS — on Windows the separator is
    // `\`, on POSIX it's `/`. The probe builds the path via `path.join(homeDir,
    // '.gemini', 'settings.json')`, so the canonical comparison value is the
    // same call.
    expect(observedPath).toBe(path.join('C:\\Users\\test', '.gemini', 'settings.json'));
  });
});
