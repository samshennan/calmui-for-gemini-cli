import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { createInitProposal, discoverMemorySources, getMemoryCandidates, getProjectMemoryPath } from './memoryStudio';

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'calmui-memory-'));
  tempDirs.push(dir);
  return dir;
}

describe('memoryStudio discovery', () => {
  it('orders project, ancestor, and global GEMINI.md candidates', () => {
    const workspace = path.join(os.tmpdir(), 'repo', 'packages', 'app');
    const home = path.join(os.tmpdir(), 'home', 'sam');
    const candidates = getMemoryCandidates(workspace, home);

    expect(candidates[0]).toEqual({ path: path.join(workspace, 'GEMINI.md'), kind: 'project' });
    expect(candidates.some(candidate => candidate.kind === 'ancestor')).toBe(true);
    expect(candidates.at(-1)).toEqual({ path: path.join(home, '.gemini', 'GEMINI.md'), kind: 'global' });
  });

  it('reads existing memory files without inventing content for missing files', async () => {
    const root = await tempRoot();
    const workspace = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    await mkdir(workspace, { recursive: true });
    await mkdir(path.join(home, '.gemini'), { recursive: true });
    await writeFile(path.join(workspace, 'GEMINI.md'), '# Project\n', 'utf8');

    const sources = await discoverMemorySources({ workspaceRoot: workspace, homeDir: home });

    expect(sources[0]).toMatchObject({
      path: path.join(workspace, 'GEMINI.md'),
      kind: 'project',
      exists: true,
      content: '# Project\n',
    });
    expect(sources.at(-1)).toMatchObject({
      path: path.join(home, '.gemini', 'GEMINI.md'),
      kind: 'global',
      exists: false,
      content: '',
    });
  });

  it('targets project-level GEMINI.md for memory adds', () => {
    const workspace = path.join(os.tmpdir(), 'repo', 'app');
    expect(getProjectMemoryPath(workspace)).toBe(path.join(workspace, 'GEMINI.md'));
  });
});

describe('createInitProposal', () => {
  it('creates a reviewable proposal without mutating the current content', () => {
    const now = new Date('2026-04-30T12:00:00.000Z');
    const proposal = createInitProposal({
      targetPath: 'C:\\repo\\GEMINI.md',
      currentContent: 'existing',
      workspaceName: 'GeminiCLI',
      now,
    });

    expect(proposal.id).toBe(`init-${now.getTime()}`);
    expect(proposal.currentContent).toBe('existing');
    expect(proposal.proposedContent).toContain('# GeminiCLI');
    expect(proposal.proposedContent).toContain('Gemini CLI');
  });
});
