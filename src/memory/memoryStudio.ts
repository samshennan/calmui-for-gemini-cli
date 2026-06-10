import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

import type { MemoryInitProposal, MemorySource, MemoryState } from '../shared/messages';

export interface MemoryDiscoveryOptions {
  workspaceRoot?: string | null;
  homeDir?: string;
  now?: Date;
}

export async function discoverMemoryState(options: MemoryDiscoveryOptions = {}): Promise<MemoryState> {
  const sources = await discoverMemorySources(options);
  return {
    status: 'idle',
    generatedAt: (options.now ?? new Date()).toISOString(),
    sources,
  };
}

export async function discoverMemorySources(options: MemoryDiscoveryOptions = {}): Promise<MemorySource[]> {
  const homeDir = options.homeDir ?? os.homedir();
  const candidates = getMemoryCandidates(options.workspaceRoot ?? null, homeDir);
  const seen = new Set<string>();
  const sources: MemorySource[] = [];

  for (const candidate of candidates) {
    const normalized = path.normalize(candidate.path);
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      path: normalized,
      kind: candidate.kind,
      exists: await fileExists(normalized),
      content: await readTextIfExists(normalized),
    });
  }

  return sources;
}

export function getMemoryCandidates(workspaceRoot: string | null, homeDir: string): Array<{ path: string; kind: MemorySource['kind'] }> {
  const candidates: Array<{ path: string; kind: MemorySource['kind'] }> = [];
  if (workspaceRoot) {
    let current = path.resolve(workspaceRoot);
    const root = path.parse(current).root;
    candidates.push({ path: path.join(current, 'GEMINI.md'), kind: 'project' });
    while (current !== root) {
      current = path.dirname(current);
      if (current !== root) {
        candidates.push({ path: path.join(current, 'GEMINI.md'), kind: 'ancestor' });
      }
    }
  }
  candidates.push({ path: path.join(homeDir, '.gemini', 'GEMINI.md'), kind: 'global' });
  return candidates;
}

export function getProjectMemoryPath(workspaceRoot?: string | null): string {
  return path.join(workspaceRoot ? path.resolve(workspaceRoot) : process.cwd(), 'GEMINI.md');
}

export function createInitProposal({
  targetPath,
  currentContent,
  workspaceName,
  now = new Date(),
}: {
  targetPath: string;
  currentContent: string;
  workspaceName: string;
  now?: Date;
}): MemoryInitProposal {
  const proposedContent = [
    `# ${workspaceName}`,
    '',
    '## Project Context',
    '- Add durable conventions, architecture notes, and workflow preferences here.',
    '- Keep entries concise and update them when the project changes.',
    '',
    '## CalmUI Notes',
    '- This file is read by Gemini CLI as project memory.',
    '',
  ].join('\n');

  return {
    id: `init-${now.getTime()}`,
    targetPath,
    currentContent,
    proposedContent,
    createdAt: now.toISOString(),
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}
