import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverGeminiExtensions } from './extensionManager';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calmui-ext-'));
  tempRoots.push(dir);
  return dir;
}

function writeManifest(root: string, name: string, manifest: unknown): void {
  const dir = path.join(root, '.gemini', 'extensions', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'gemini-extension.json'), JSON.stringify(manifest, null, 2));
}

describe('discoverGeminiExtensions', () => {
  it('discovers user extension metadata and contributions', () => {
    const homeDir = tempDir();
    writeManifest(homeDir, 'docs', {
      name: 'docs',
      version: '1.2.3',
      description: 'Documentation tools',
      source: 'https://example.com/docs.git',
      mcpServers: { docs: { command: 'node' } },
      commands: [{ name: '/docs' }],
      contextProviders: ['repo-map'],
      skills: { summarize: {} },
      hooks: ['pre-prompt'],
      enabled: true,
    });

    const report = discoverGeminiExtensions({ homeDir });
    expect(report.extensions).toHaveLength(1);
    expect(report.extensions[0]).toMatchObject({
      name: 'docs',
      version: '1.2.3',
      sourceKind: 'user',
      status: 'enabled',
    });
    expect(report.extensions[0].contributions.map(item => [item.kind, item.names])).toEqual([
      ['mcp', ['docs']],
      ['command', ['/docs']],
      ['context', ['repo-map']],
      ['skill', ['summarize']],
      ['hook', ['pre-prompt']],
    ]);
  });

  it('discovers workspace extensions and reports malformed manifests', () => {
    const homeDir = tempDir();
    const workspace = tempDir();
    const brokenDir = path.join(workspace, '.gemini', 'extensions', 'broken');
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, 'gemini-extension.json'), '{');
    writeManifest(workspace, 'good', { id: 'workspace-good', disabled: true });

    const report = discoverGeminiExtensions({ homeDir, workspaceFolders: [workspace] });
    expect(report.extensions.map(item => item.name)).toEqual(['workspace-good']);
    expect(report.extensions[0].sourceKind).toBe('workspace');
    expect(report.extensions[0].status).toBe('disabled');
    expect(report.warnings[0]).toContain('Could not parse');
  });

  it('discovers command TOML files and default context files', () => {
    const homeDir = tempDir();
    writeManifest(homeDir, 'gcp', { name: 'gcp', version: '1.0.0' });
    const extensionDir = path.join(homeDir, '.gemini', 'extensions', 'gcp');
    fs.mkdirSync(path.join(extensionDir, 'commands', 'gcs'), { recursive: true });
    fs.writeFileSync(path.join(extensionDir, 'commands', 'deploy.toml'), 'prompt = "deploy"');
    fs.writeFileSync(path.join(extensionDir, 'commands', 'gcs', 'sync.toml'), 'prompt = "sync"');
    fs.writeFileSync(path.join(extensionDir, 'GEMINI.md'), 'context');

    const contributions = discoverGeminiExtensions({ homeDir }).extensions[0].contributions;
    expect(contributions.find(item => item.kind === 'command')?.names).toEqual(['/deploy', '/gcs:sync']);
    expect(contributions.find(item => item.kind === 'context')?.names).toEqual(['GEMINI.md']);
  });
});
