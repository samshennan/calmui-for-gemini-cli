import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type {
  DiagnosticsAction,
  DiagnosticsCheck,
  DiagnosticsReport,
  DiagnosticsStatus,
  PromptCapabilities,
} from './shared/messages';

interface RawCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  fix?: string;
  action?: DiagnosticsAction;
}

export async function runDiagnostics(
  outputChannel: vscode.OutputChannel,
  context: vscode.ExtensionContext,
  /**
   * Phase 39 W2: live ACP `promptCapabilities` accessor. When supplied, the
   * `search-grounding` probe can take cached capabilities into account in
   * addition to settings.json. Optional — passing `undefined` keeps the W0
   * degraded path (capabilities treated as `null`).
   */
  capabilities?: PromptCapabilities | null,
): Promise<DiagnosticsReport> {
  const config = vscode.workspace.getConfiguration('calmui');
  const geminiPath = config.get<string>('geminiPath', 'gemini').trim() || 'gemini';
  const useAcp = config.get<boolean>('useAcp', true);
  const attachMcpServersToAcp = config.get<boolean>('attachMcpServersToAcp', false);
  const useVertexAI = config.get<boolean>('useVertexAI', true);
  const configuredProject = config.get<string>('googleCloudProject', '').trim();
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  const packageJson = context.extension.packageJSON as { version?: string };
  const hasApiKey = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);

  const checks: RawCheck[] = [];
  checks.push({
    id: 'extension',
    label: 'Extension',
    ok: true,
    detail: `version=${packageJson.version ?? 'unknown'} vscode=${vscode.version}`,
  });
  checks.push({
    id: 'transport',
    label: 'Transport',
    ok: useAcp,
    detail: useAcp ? 'ACP default is enabled' : 'Legacy stream-json fallback is enabled',
    fix: useAcp ? undefined : 'Enable CalmUI: Use ACP for sessions, permissions, and images.',
    action: useAcp ? 'retryAcp' : 'openVSCodeSettings',
  });
  checks.push({
    id: 'workspace',
    label: 'Workspace',
    ok: Boolean(workspaceFolder),
    detail: workspaceFolder ?? 'No workspace folder is open',
    fix: workspaceFolder ? undefined : 'Open a workspace folder before starting a project chat.',
  });

  const cli = probeGeminiCli(geminiPath);
  checks.push({
    id: 'gemini-cli',
    label: 'Gemini CLI',
    ok: cli.ok,
    detail: cli.detail,
    fix: cli.ok ? undefined : 'Install Gemini CLI or set CalmUI: Gemini Path to the CLI binary.',
    action: cli.ok ? undefined : 'openVSCodeSettings',
  });

  const acpBundle = probeAcpBundle(geminiPath);
  checks.push({
    id: 'acp-bundle',
    label: 'ACP bundle',
    ok: acpBundle.ok,
    detail: acpBundle.detail,
    fix: acpBundle.ok ? undefined : 'Install @google/gemini-cli globally or point CalmUI at gemini.js.',
    action: acpBundle.ok ? undefined : 'openVSCodeSettings',
  });

  const mcpServer = vscode.Uri.joinPath(context.extensionUri, 'media', 'calmui-context-mcp-server.js').fsPath;
  const hasMcpServer = fs.existsSync(mcpServer);
  checks.push({
    id: 'mcp-context-server',
    label: 'Optional MCP context server',
    ok: hasMcpServer,
    detail: attachMcpServersToAcp
      ? `enabled for ACP sessions: ${mcpServer}`
      : `installed but not attached to ACP sessions: ${mcpServer}`,
    fix: hasMcpServer ? undefined : 'Reinstall or rebuild the extension so the MCP context server is packaged.',
  });

  checks.push({
    id: 'auth-mode',
    label: 'Auth mode',
    ok: true,
    detail: useVertexAI
      ? `enabled project=${configuredProject || process.env.GOOGLE_CLOUD_PROJECT || '(inherited/unset)'}`
      : hasApiKey
        ? 'API key mode; key found in extension host environment'
        : 'API key mode; no key found in extension host environment yet',
    action: 'openVSCodeSettings',
  });

  // Real `search-grounding` probe replacing the placeholder.
  // Phase 39 W2: live capabilities (when available) are now threaded through
  // from `ChatPanelProvider` via the `runDiagnostics` extension-level wrapper.
  const sgResult = probeSearchGrounding({
    homeDir: os.homedir(),
    workspaceRoot: workspaceFolder ?? undefined,
    capabilities: capabilities ?? null,
  });
  checks.push({
    id: 'search-grounding',
    label: 'Search grounding',
    ok: sgResult.ok,
    detail: sgResult.detail,
    fix: sgResult.fix,
    action: sgResult.action ?? 'openGeminiSettings',
  });

  if (useVertexAI) {
    const adc = runTool('gcloud', ['auth', 'application-default', 'print-access-token'], 7000);
    checks.push({
      id: 'vertex-adc',
      label: 'Vertex ADC',
      ok: adc.ok,
      detail: adc.ok
        ? 'application default credentials are available'
        : formatToolFailure(adc, 'Run: gcloud auth application-default login'),
      fix: adc.ok ? undefined : 'Run gcloud auth application-default login, then retry diagnostics.',
      action: adc.ok ? undefined : 'refreshGcloud',
    });

    const project = runTool('gcloud', ['config', 'get-value', 'project'], 5000);
    const projectValue = project.stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(line => line && line !== '(unset)' && !line.startsWith('Your active configuration is:'));
    const hasProject = Boolean(configuredProject || projectValue || process.env.GOOGLE_CLOUD_PROJECT);
    checks.push({
      id: 'google-cloud-project',
      label: 'Google Cloud project',
      ok: hasProject,
      detail: configuredProject || projectValue || process.env.GOOGLE_CLOUD_PROJECT || 'No project configured',
      fix: hasProject ? undefined : 'Set CalmUI: Google Cloud Project or configure a gcloud default project.',
      action: hasProject ? undefined : 'openVSCodeSettings',
    });
  } else {
    checks.push({
      id: 'api-key',
      label: 'API key',
      ok: hasApiKey,
      detail: process.env.GEMINI_API_KEY
        ? 'GEMINI_API_KEY is set'
        : process.env.GOOGLE_API_KEY
          ? 'GOOGLE_API_KEY is set'
          : 'No GEMINI_API_KEY or GOOGLE_API_KEY found in extension host environment',
      fix: hasApiKey ? undefined : 'Set GEMINI_API_KEY or enable Vertex AI in CalmUI settings.',
      action: hasApiKey ? undefined : 'openVSCodeSettings',
    });
  }

  const report = buildDiagnosticsReport(checks);
  writeDiagnosticsReport(outputChannel, report);
  return report;
}

export async function showDiagnosticsNotification(report: DiagnosticsReport): Promise<void> {
  const failed = report.checks.filter(check => check.status === 'fail');
  if (failed.length === 0) {
    await vscode.window.showInformationMessage('CalmUI diagnostics passed. ACP is ready.');
    return;
  }

  await vscode.window.showWarningMessage(
    `CalmUI diagnostics found ${failed.length} issue${failed.length === 1 ? '' : 's'}. See the CalmUI for Gemini CLI output channel.`,
  );
}

export function buildDiagnosticsReport(checks: RawCheck[]): DiagnosticsReport {
  const normalized: DiagnosticsCheck[] = checks.map((check) => {
    const status = check.ok ? 'pass' : statusForCheck(check.id);
    return {
      id: check.id,
      label: check.label,
      status,
      detail: check.detail,
      fix: check.fix,
      action: status === 'pass' ? check.action : check.action ?? 'runDiagnostics',
    };
  });
  const passed = normalized.filter(check => check.status === 'pass').length;
  return {
    generatedAt: new Date().toISOString(),
    passed,
    total: normalized.length,
    checks: normalized,
  };
}

export function writeDiagnosticsReport(
  outputChannel: vscode.OutputChannel,
  report: DiagnosticsReport,
): void {
  outputChannel.appendLine('');
  outputChannel.appendLine('=== CalmUI Diagnostics ===');
  for (const check of report.checks) {
    outputChannel.appendLine(`${check.status.toUpperCase()} ${check.label}: ${check.detail}`);
    if (check.fix) {
      outputChannel.appendLine(`  Fix: ${check.fix}`);
    }
  }
  outputChannel.appendLine(`Summary: ${report.passed}/${report.total} checks passed`);
  outputChannel.show(true);
}

function statusForCheck(id: string): DiagnosticsStatus {
  // 'search-grounding' is a feature toggle, not a setup blocker — failures
  // downgrade to `warn` so they don't block the overall diagnostics gate.
  // (search-grounding D-15.)
  if (id === 'transport' || id === 'workspace' || id === 'search-grounding') return 'warn';
  return 'fail';
}

function probeGeminiCli(geminiPath: string): { ok: boolean; detail: string } {
  if (hasPathSeparator(geminiPath)) {
    if (!fs.existsSync(geminiPath)) {
      return { ok: false, detail: `Configured path does not exist: ${geminiPath}` };
    }
    const version = runTool(geminiPath, ['--version'], 5000);
    return {
      ok: version.ok,
      detail: version.ok ? `${geminiPath} ${version.stdout.trim()}` : formatToolFailure(version, geminiPath),
    };
  }

  const lookup = process.platform === 'win32'
    ? runTool('where.exe', [geminiPath], 5000)
    : runTool('command', ['-v', geminiPath], 5000, true);
  if (!lookup.ok) {
    return { ok: false, detail: `Not found on PATH as "${geminiPath}"` };
  }

  const version = runTool(geminiPath, ['--version'], 5000, process.platform === 'win32');
  const resolved = lookup.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)[0] ?? geminiPath;
  return {
    ok: true,
    detail: version.ok ? `${resolved} ${version.stdout.trim()}` : `${resolved}; version probe failed: ${formatToolFailure(version)}`,
  };
}

function probeAcpBundle(geminiPath: string): { ok: boolean; detail: string } {
  if (process.platform !== 'win32') {
    return { ok: true, detail: 'non-Windows uses gemini --acp from PATH/configured path' };
  }

  const bundlePath = geminiPath.toLowerCase().endsWith('.js')
    ? geminiPath
    : getDefaultWindowsBundlePath();
  return fs.existsSync(bundlePath)
    ? { ok: true, detail: bundlePath }
    : {
        ok: false,
        detail: `Missing ${bundlePath}. Install @google/gemini-cli globally or set CalmUI: Gemini Path to gemini.js.`,
      };
}

function getDefaultWindowsBundlePath(): string {
  const npmPrefix = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '';
  return path.join(npmPrefix, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
}

function runTool(
  command: string,
  args: string[],
  timeout: number,
  shell = false,
): { ok: boolean; status: number | null; stdout: string; stderr: string; error?: string } {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    windowsHide: true,
    timeout,
    shell,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message,
  };
}

function formatToolFailure(
  result: { status: number | null; stdout: string; stderr: string; error?: string },
  fallback = 'Check command availability and credentials',
): string {
  const message = [result.error, result.stderr, result.stdout]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return message || `exit=${result.status ?? 'unknown'}; ${fallback}`;
}

function hasPathSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

// =============================================================================
// search-grounding probe
// =============================================================================
//
// Pure helper — no `vscode` calls so it's trivially unit-testable (Wave 5).
// Reads `<homeDir>/.gemini/settings.json` and the optional workspace override
// `<workspaceRoot>/.gemini/settings.json`, then derives a single pass/warn
// signal for the diagnostics row. Per RESEARCH.md §2 D-15, defaults are
// permissive: when nothing is found, search is on.

export interface ProbeSearchGroundingOpts {
  homeDir: string;
  workspaceRoot?: string;
  capabilities: PromptCapabilities | null;
}

export interface ProbeSearchGroundingResult {
  ok: boolean;
  detail: string;
  fix?: string;
  action?: DiagnosticsAction;
}

interface ParsedSettings {
  /** Absolute path the file was read from. */
  filePath: string;
  /** Whether the file existed (vs. ENOENT). */
  exists: boolean;
  /** Whether the file existed but parsed/read cleanly. */
  readable: boolean;
  /** Parsed JSON object, or null if the file was missing/malformed. */
  data: Record<string, unknown> | null;
}

/**
 * Read `<dir>/.gemini/settings.json` defensively. Never throws; the caller
 * inspects the returned shape to decide warning vs. ok.
 */
function readGeminiSettingsFile(dir: string): ParsedSettings {
  const filePath = path.join(dir, '.gemini', 'settings.json');
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return { filePath, exists: false, readable: false, data: null };
    }
    return { filePath, exists: true, readable: false, data: null };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return { filePath, exists: true, readable: true, data: parsed as Record<string, unknown> };
    }
    return { filePath, exists: true, readable: false, data: null };
  } catch {
    return { filePath, exists: true, readable: false, data: null };
  }
}

/**
 * Extract the `tools.exclude` array from a parsed settings.json, accepting the
 * legacy `coreTools` alias key as fallback. Returns `null` when neither key is
 * present (defaults apply).
 */
function readExcludedTools(data: Record<string, unknown> | null): string[] | null {
  if (!data) return null;
  const tools = data.tools;
  if (tools && typeof tools === 'object') {
    const exclude = (tools as Record<string, unknown>).exclude;
    if (Array.isArray(exclude)) return exclude.filter((v): v is string => typeof v === 'string');
  }
  // Legacy alias: `coreTools` at the root or under `tools`.
  const legacy = data.coreTools;
  if (Array.isArray(legacy)) return legacy.filter((v): v is string => typeof v === 'string');
  if (tools && typeof tools === 'object') {
    const legacyNested = (tools as Record<string, unknown>).coreTools;
    if (Array.isArray(legacyNested)) return legacyNested.filter((v): v is string => typeof v === 'string');
  }
  return null;
}

/**
 * Read `tools.sandboxNetworkAccess`. Returns `undefined` when unset (defaults
 * apply — network is reachable).
 */
function readSandboxNetworkAccess(data: Record<string, unknown> | null): boolean | undefined {
  if (!data) return undefined;
  const tools = data.tools;
  if (tools && typeof tools === 'object') {
    const v = (tools as Record<string, unknown>).sandboxNetworkAccess;
    if (typeof v === 'boolean') return v;
  }
  return undefined;
}

/**
 * Probe whether Google Search grounding is currently usable.
 *
 * Precedence (workspace settings.json overrides user settings.json):
 *   1. `tools.exclude` (or legacy `coreTools`) contains "google_web_search" → not ok.
 *   2. `tools.sandboxNetworkAccess: false` → not ok.
 *   3. Otherwise → ok (defaults apply; search is on by default in gemini-cli).
 *
 * Capabilities-awareness is plumbed through but not yet used at the W0 layer.
 * W2 will populate `capabilities` from the live `GeminiProcessAcp` accessor;
 * for now passing `null` is a fully supported degraded path.
 *
 * Never throws. Malformed JSON in either file is treated as "could not verify"
 * — the probe stays ok (search-on by default) but the detail string surfaces
 * the verification gap so the user can investigate.
 */
export function probeSearchGrounding(opts: ProbeSearchGroundingOpts): ProbeSearchGroundingResult {
  const userSettings = readGeminiSettingsFile(opts.homeDir);
  const workspaceSettings = opts.workspaceRoot ? readGeminiSettingsFile(opts.workspaceRoot) : null;

  // Workspace overrides user. Check workspace first; fall back to user.
  const wsExcluded = readExcludedTools(workspaceSettings?.data ?? null);
  const userExcluded = readExcludedTools(userSettings.data);
  const excludedFile = wsExcluded ? workspaceSettings!.filePath : userExcluded ? userSettings.filePath : null;
  const excluded = wsExcluded ?? userExcluded ?? null;

  if (excluded && excluded.includes('google_web_search') && excludedFile) {
    return {
      ok: false,
      detail: `\`google_web_search\` is excluded in ${excludedFile}.`,
      fix: `Remove \`google_web_search\` from \`tools.exclude\` in ${excludedFile}.`,
      action: 'openGeminiSettings',
    };
  }

  // Workspace overrides user for sandboxNetworkAccess as well.
  const wsSandbox = readSandboxNetworkAccess(workspaceSettings?.data ?? null);
  const userSandbox = readSandboxNetworkAccess(userSettings.data);
  const sandboxFile = wsSandbox !== undefined
    ? workspaceSettings!.filePath
    : userSandbox !== undefined
      ? userSettings.filePath
      : null;
  const sandbox = wsSandbox !== undefined ? wsSandbox : userSandbox;

  if (sandbox === false && sandboxFile) {
    return {
      ok: false,
      detail: `\`tools.sandboxNetworkAccess\` is disabled in ${sandboxFile}; web search will fail at runtime.`,
      fix: `Set \`tools.sandboxNetworkAccess: true\` or remove the key in ${sandboxFile}.`,
      action: 'openGeminiSettings',
    };
  }

  // Surface unparseable files as a verification gap (still ok — defaults apply).
  const unparseable: string[] = [];
  if (userSettings.exists && !userSettings.readable) unparseable.push(userSettings.filePath);
  if (workspaceSettings && workspaceSettings.exists && !workspaceSettings.readable) {
    unparseable.push(workspaceSettings.filePath);
  }
  if (unparseable.length > 0) {
    return {
      ok: true,
      detail: `Could not verify ${unparseable.join(', ')} (malformed JSON); assuming defaults apply (google_web_search enabled).`,
      action: 'openGeminiSettings',
    };
  }

  // Both files missing or both clean with no exclusions/sandbox restrictions.
  const anyExisting = userSettings.exists || (workspaceSettings?.exists ?? false);
  return {
    ok: true,
    detail: anyExisting
      ? 'Google Search grounding available via gemini-cli `google_web_search` tool.'
      : 'Defaults apply: google_web_search is enabled in Gemini CLI.',
    action: 'openGeminiSettings',
  };
}
