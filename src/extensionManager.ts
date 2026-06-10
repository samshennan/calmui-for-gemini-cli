import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  GeminiExtensionContribution,
  GeminiExtensionContributionKind,
  GeminiExtensionInfo,
  GeminiExtensionReport,
  GeminiExtensionSourceKind,
  GeminiExtensionStatus,
} from './shared/messages';

export interface GeminiExtensionDiscoveryOptions {
  workspaceFolders?: string[];
  homeDir?: string;
  restartRequired?: boolean;
  lastAction?: string;
}

interface ManifestCandidate {
  sourceKind: GeminiExtensionSourceKind;
  extensionDir: string;
  manifestPath: string;
}

export function discoverGeminiExtensions(options: GeminiExtensionDiscoveryOptions = {}): GeminiExtensionReport {
  const homeDir = options.homeDir ?? os.homedir();
  const warnings: string[] = [];
  const extensions: GeminiExtensionInfo[] = [];

  for (const candidate of getManifestCandidates(homeDir, options.workspaceFolders ?? [])) {
    if (!fs.existsSync(candidate.manifestPath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate.manifestPath, 'utf8'));
      const manifest = isRecord(parsed) ? parsed : {};
      extensions.push(readExtension(candidate, manifest));
    } catch (err) {
      warnings.push(`Could not parse ${candidate.manifestPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  extensions.sort((a, b) => a.name.localeCompare(b.name) || a.sourceKind.localeCompare(b.sourceKind));
  return {
    generatedAt: new Date().toISOString(),
    extensions,
    warnings,
    restartRequired: options.restartRequired ?? false,
    lastAction: options.lastAction,
  };
}

function getManifestCandidates(homeDir: string, workspaceFolders: string[]): ManifestCandidate[] {
  const roots: Array<{ sourceKind: GeminiExtensionSourceKind; root: string }> = [];
  if (homeDir) roots.push({ sourceKind: 'user', root: path.join(homeDir, '.gemini', 'extensions') });
  for (const folder of workspaceFolders) {
    roots.push({ sourceKind: 'workspace', root: path.join(folder, '.gemini', 'extensions') });
  }

  const candidates: ManifestCandidate[] = [];
  for (const { sourceKind, root } of roots) {
    if (!fs.existsSync(root)) continue;
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const extensionDir = path.join(root, entry.name);
        candidates.push({
          sourceKind,
          extensionDir,
          manifestPath: path.join(extensionDir, 'gemini-extension.json'),
        });
      }
    } catch {
      // Ignore unreadable extension roots; individual malformed manifests are reported above.
    }
  }
  return candidates;
}

function readExtension(candidate: ManifestCandidate, manifest: Record<string, unknown>): GeminiExtensionInfo {
  const fallbackName = path.basename(candidate.extensionDir);
  const name = readString(manifest.name) ?? readString(manifest.id) ?? fallbackName;
  return {
    id: `${candidate.sourceKind}:${name}:${candidate.manifestPath}`,
    name,
    version: readString(manifest.version),
    description: readString(manifest.description),
    source: readString(manifest.source) ?? readString(manifest.repository) ?? readString(manifest.url),
    sourceKind: candidate.sourceKind,
    path: candidate.extensionDir,
    manifestPath: candidate.manifestPath,
    status: readStatus(manifest),
    contributions: [
      readContribution('mcp', manifest.mcpServers),
      readContribution('command', [
        ...readNames(manifest.commands ?? manifest.slashCommands ?? manifest.customCommands),
        ...readCommandNames(candidate.extensionDir),
      ]),
      readContribution('context', [
        ...readNames(manifest.context ?? manifest.contextProviders),
        ...readContextNames(candidate.extensionDir, manifest),
      ]),
      readContribution('skill', manifest.skills),
      readContribution('hook', manifest.hooks),
    ].filter((item): item is GeminiExtensionContribution => item !== null),
  };
}

function readStatus(manifest: Record<string, unknown>): GeminiExtensionStatus {
  if (manifest.enabled === true || manifest.disabled === false) return 'enabled';
  if (manifest.enabled === false || manifest.disabled === true) return 'disabled';
  if (typeof manifest.status === 'string') {
    const status = manifest.status.toLowerCase();
    if (status === 'enabled' || status === 'disabled') return status;
  }
  return 'enabled';
}

function readContribution(kind: GeminiExtensionContributionKind, value: unknown): GeminiExtensionContribution | null {
  const names = readNames(value);
  return names.length > 0 ? { kind, names } : null;
}

function readNames(value: unknown): string[] {
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
    return unique(value.map(item => item.trim()).filter(Boolean));
  }
  if (Array.isArray(value)) {
    return unique(value
      .map(item => typeof item === 'string' ? item : isRecord(item) ? readString(item.name) ?? readString(item.id) : undefined)
      .filter((item): item is string => Boolean(item)));
  }
  if (isRecord(value)) return Object.keys(value);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function readCommandNames(extensionDir: string): string[] {
  const commandsDir = path.join(extensionDir, 'commands');
  if (!fs.existsSync(commandsDir)) return [];
  const files: string[] = [];
  collectFiles(commandsDir, '.toml', files);
  return unique(files.map(file => {
    const relative = path.relative(commandsDir, file).replace(/\\/g, '/').replace(/\.toml$/i, '');
    const segments = relative.split('/').filter(Boolean);
    return segments.length > 1 ? `/${segments.join(':')}` : `/${segments[0]}`;
  }));
}

function readContextNames(extensionDir: string, manifest: Record<string, unknown>): string[] {
  const names = readNames(manifest.contextFileName);
  if (names.length > 0) return names;
  return fs.existsSync(path.join(extensionDir, 'GEMINI.md')) ? ['GEMINI.md'] : [];
}

function collectFiles(dir: string, extension: string, files: string[]): void {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collectFiles(entryPath, extension, files);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) {
        files.push(entryPath);
      }
    }
  } catch {
    // Unreadable command directories simply have no discoverable commands.
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
