import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverGeminiMcpServers,
  getMcpServerSignature,
  inspectMcpServers,
  mergeMcpServers,
} from './mcpInspector';
import type { AcpMcpServer } from './process/GeminiProcessAcp';

const tempPaths: string[] = [];

afterEach(() => {
  for (const tempPath of tempPaths.splice(0)) {
    try {
      fs.rmSync(tempPath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup for temp files created during tests.
    }
  }
});

describe('inspectMcpServers', () => {
  it('loads tool metadata from the local CalmUI stdio MCP server', async () => {
    const contextPath = path.join(os.tmpdir(), `calmui-mcp-${Date.now()}.json`);
    tempPaths.push(contextPath);
    fs.writeFileSync(contextPath, JSON.stringify({
      workspace: '/tmp/workspace',
      capturedAt: '2026-04-30T00:00:00.000Z',
      activeFile: {
        path: 'src/example.ts',
        selection: 'const value = 1;',
        cursor: { line: 1, character: 1 },
      },
      visibleFiles: [],
    }));

    const server: AcpMcpServer = {
      name: 'calmui-context',
      command: process.execPath,
      args: [path.join(process.cwd(), 'media', 'calmui-context-mcp-server.js')],
      env: [{ name: 'CALMUI_CONTEXT_FILE', value: contextPath }],
    };

    const report = await inspectMcpServers([server]);
    expect(report.servers).toHaveLength(1);
    expect(report.servers[0].status).toBe('connected');
    expect(report.servers[0].toolCount).toBe(2);
    expect(report.servers[0].tools.map(tool => tool.name)).toEqual([
      'calmui_editor_context',
      'calmui_current_selection',
    ]);
    expect(report.servers[0].tools[0].inputSchema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  it('reports a missing stdio command as a failure with a fix action', async () => {
    const report = await inspectMcpServers([{
      name: 'broken-server',
      command: path.join(process.cwd(), 'missing', 'server.js'),
      args: [],
      env: [],
    }]);

    expect(report.servers[0].status).toBe('fail');
    expect(report.servers[0].action).toBe('openGeminiSettings');
    expect(report.servers[0].detail).toContain('not found');
  });

  it('preserves restart-required metadata for the UI', async () => {
    const report = await inspectMcpServers([], { restartRequired: true });
    expect(report.restartRequired).toBe(true);
  });
});

describe('discoverGeminiMcpServers', () => {
  it('loads stdio and HTTP MCP servers from user and workspace Gemini settings', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calmui-home-'));
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calmui-workspace-'));
    tempPaths.push(homeDir, workspaceDir);
    fs.mkdirSync(path.join(homeDir, '.gemini'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, '.gemini'), { recursive: true });

    fs.writeFileSync(path.join(homeDir, '.gemini', 'settings.json'), JSON.stringify({
      mcpServers: {
        docs: {
          command: 'npx',
          args: ['-y', '@example/docs-mcp'],
          env: { DOCS_TOKEN: '$DOCS_TOKEN' },
          cwd: '${extensionPath}',
          timeout: 12000,
          includeTools: ['search_docs'],
          excludeTools: ['delete_docs'],
        },
        disabled: { command: 'disabled-mcp' },
      },
    }));
    fs.writeFileSync(path.join(workspaceDir, '.gemini', 'settings.json'), JSON.stringify({
      mcp: { excluded: ['disabled'] },
      mcpServers: {
        remote: {
          type: 'http',
          url: 'https://mcp.example.test',
          headers: { Authorization: 'Bearer token' },
        },
        socket: {
          tcp: '127.0.0.1:8123',
        },
      },
    }));

    const result = discoverGeminiMcpServers({ homeDir, workspaceFolders: [workspaceDir] });

    expect(result.warnings).toEqual([]);
    expect(result.servers).toEqual([
      {
        name: 'docs',
        command: 'npx',
        args: ['-y', '@example/docs-mcp'],
        env: [{ name: 'DOCS_TOKEN', value: '$DOCS_TOKEN' }],
        cwd: path.join(homeDir, '.gemini'),
        timeout: 12000,
        includeTools: ['search_docs'],
        excludeTools: ['delete_docs'],
      },
      {
        name: 'remote',
        type: 'http',
        url: 'https://mcp.example.test',
        headers: [{ name: 'Authorization', value: 'Bearer token' }],
      },
      {
        name: 'socket',
        type: 'tcp',
        tcp: '127.0.0.1:8123',
      },
    ]);
  });

  it('lets workspace MCP server entries override user entries by name', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calmui-home-'));
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calmui-workspace-'));
    tempPaths.push(homeDir, workspaceDir);
    fs.mkdirSync(path.join(homeDir, '.gemini'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.gemini', 'settings.json'), JSON.stringify({
      mcpServers: { shared: { command: 'user-command' } },
    }));
    fs.writeFileSync(path.join(workspaceDir, '.gemini', 'settings.json'), JSON.stringify({
      mcpServers: { shared: { command: 'workspace-command', args: ['--workspace'] } },
    }));

    const result = discoverGeminiMcpServers({ homeDir, workspaceFolders: [workspaceDir] });

    expect(result.servers).toEqual([{
      name: 'shared',
      command: 'workspace-command',
      args: ['--workspace'],
      env: [],
    }]);
  });

  it('loads MCP servers contributed by installed Gemini CLI extensions', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calmui-home-'));
    tempPaths.push(homeDir);
    const extensionDir = path.join(homeDir, '.gemini', 'extensions', 'example-extension');
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.writeFileSync(path.join(extensionDir, 'gemini-extension.json'), JSON.stringify({
      name: 'example-extension',
      mcpServers: {
        extensionServer: {
          command: 'node',
          args: ['${extensionPath}${/}server.js'],
          cwd: '${extensionPath}',
        },
      },
    }));

    const result = discoverGeminiMcpServers({ homeDir });

    expect(result.servers).toEqual([{
      name: 'extensionServer',
      command: 'node',
      args: [path.join(extensionDir, 'server.js')],
      env: [],
      cwd: extensionDir,
    }]);
  });

  it('lets Gemini settings override same-named extension MCP servers', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calmui-home-'));
    tempPaths.push(homeDir);
    const extensionDir = path.join(homeDir, '.gemini', 'extensions', 'example-extension');
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.mkdirSync(path.join(homeDir, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(extensionDir, 'gemini-extension.json'), JSON.stringify({
      mcpServers: { shared: { command: 'extension-command' } },
    }));
    fs.writeFileSync(path.join(homeDir, '.gemini', 'settings.json'), JSON.stringify({
      mcpServers: { shared: { command: 'settings-command' } },
    }));

    const result = discoverGeminiMcpServers({ homeDir });

    expect(result.servers).toEqual([{
      name: 'shared',
      command: 'settings-command',
      args: [],
      env: [],
    }]);
  });
});

describe('mergeMcpServers', () => {
  it('keeps CalmUI-owned servers ahead of same-named Gemini settings servers', () => {
    const primary: AcpMcpServer[] = [{ name: 'calmui-context', command: 'node', args: ['local.js'], env: [] }];
    const discovered: AcpMcpServer[] = [{ name: 'calmui-context', command: 'other', args: [], env: [] }];

    expect(mergeMcpServers(primary, discovered)).toEqual(primary);
  });

  it('builds stable signatures independent of server order', () => {
    const first: AcpMcpServer[] = [
      { name: 'b', command: 'b', args: [], env: [] },
      { name: 'a', command: 'a', args: [], env: [] },
    ];
    const second = [...first].reverse();

    expect(getMcpServerSignature(first)).toBe(getMcpServerSignature(second));
  });
});
