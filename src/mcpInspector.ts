import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AcpMcpServer } from './process/GeminiProcessAcp';
import type { McpInspectorReport, McpServerInfo, McpToolInfo } from './shared/messages';

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { message?: string };
}

export async function inspectMcpServers(
  servers: AcpMcpServer[],
  options: { restartRequired?: boolean } = {},
): Promise<McpInspectorReport> {
  const results = await Promise.all(servers.map(server => inspectMcpServer(server)));
  return {
    generatedAt: new Date().toISOString(),
    servers: results,
    restartRequired: options.restartRequired ?? false,
  };
}

export interface GeminiMcpDiscoveryOptions {
  workspaceFolders?: string[];
  homeDir?: string;
}

export interface GeminiMcpDiscoveryResult {
  servers: AcpMcpServer[];
  settingsPaths: string[];
  warnings: string[];
}

export function discoverGeminiMcpServers(options: GeminiMcpDiscoveryOptions = {}): GeminiMcpDiscoveryResult {
  const homeDir = options.homeDir ?? os.homedir();
  const settingsPaths = [
    ...getGeminiExtensionManifestPaths(homeDir),
    ...getGeminiSettingsPaths(options, homeDir),
  ];
  const warnings: string[] = [];
  const servers = new Map<string, AcpMcpServer>();
  let allowed: Set<string> | undefined;
  const excluded = new Set<string>();

  for (const settingsPath of settingsPaths) {
    if (!fs.existsSync(settingsPath)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (err) {
      warnings.push(`Could not parse ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const settings = isRecord(parsed) ? parsed : {};
    const mcp = isRecord(settings.mcp) ? settings.mcp : {};
    const nextAllowed = readStringArray(mcp.allowed);
    if (nextAllowed) allowed = new Set(nextAllowed);
    for (const name of readStringArray(mcp.excluded) ?? []) excluded.add(name);

    const configured = isRecord(settings.mcpServers) ? settings.mcpServers : {};
    for (const [name, value] of Object.entries(configured)) {
      const server = readGeminiMcpServer(name, value, path.dirname(settingsPath), warnings);
      if (server) servers.set(name, server);
    }
  }

  const filtered = [...servers.values()].filter(server => {
    if (allowed && !allowed.has(server.name)) return false;
    return !excluded.has(server.name);
  });

  return {
    servers: filtered,
    settingsPaths: settingsPaths.filter(settingsPath => fs.existsSync(settingsPath)),
    warnings,
  };
}

export function mergeMcpServers(primary: AcpMcpServer[], discovered: AcpMcpServer[]): AcpMcpServer[] {
  const merged = new Map<string, AcpMcpServer>();
  for (const server of primary) merged.set(server.name, server);
  for (const server of discovered) {
    if (!merged.has(server.name)) merged.set(server.name, server);
  }
  return [...merged.values()];
}

export function getMcpServerSignature(servers: AcpMcpServer[]): string {
  return JSON.stringify(servers.map(server => {
    if ('type' in server) {
      return {
        name: server.name,
        type: server.type,
        url: 'url' in server ? server.url : undefined,
        tcp: 'tcp' in server ? server.tcp : undefined,
        headers: 'headers' in server ? [...server.headers].sort((a, b) => a.name.localeCompare(b.name)) : undefined,
        timeout: server.timeout,
        includeTools: server.includeTools,
        excludeTools: server.excludeTools,
      };
    }
    return {
      name: server.name,
      command: server.command,
      args: server.args,
      env: [...server.env].sort((a, b) => a.name.localeCompare(b.name)),
      cwd: server.cwd,
      timeout: server.timeout,
      includeTools: server.includeTools,
      excludeTools: server.excludeTools,
    };
  }).sort((a, b) => a.name.localeCompare(b.name)));
}

function getGeminiSettingsPaths(options: GeminiMcpDiscoveryOptions, homeDir: string): string[] {
  const paths: string[] = [];
  if (homeDir) paths.push(path.join(homeDir, '.gemini', 'settings.json'));
  for (const folder of options.workspaceFolders ?? []) {
    paths.push(path.join(folder, '.gemini', 'settings.json'));
  }
  return paths;
}

function getGeminiExtensionManifestPaths(homeDir: string): string[] {
  if (!homeDir) return [];
  const extensionRoot = path.join(homeDir, '.gemini', 'extensions');
  if (!fs.existsSync(extensionRoot)) return [];
  try {
    return fs.readdirSync(extensionRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(extensionRoot, entry.name, 'gemini-extension.json'));
  } catch {
    return [];
  }
}

function readGeminiMcpServer(
  name: string,
  value: unknown,
  baseDir: string,
  warnings: string[],
): AcpMcpServer | null {
  if (!isRecord(value)) {
    warnings.push(`Skipping MCP server "${name}" because its configuration is not an object.`);
    return null;
  }

  const rawType = typeof value.type === 'string' ? value.type.toLowerCase() : undefined;
  const common = readGeminiMcpServerCommon(value, baseDir);
  const tcp = readString(value.tcp, baseDir);
  if (tcp) {
    return {
      name,
      type: 'tcp',
      tcp,
      ...common,
    };
  }

  const url = readString(value.url, baseDir) ?? readString(value.httpUrl, baseDir);
  if (url) {
    return {
      name,
      type: rawType === 'http' ? 'http' : 'sse',
      url,
      headers: readEnvEntries(value.headers, baseDir),
      ...common,
    };
  }

  const command = readString(value.command, baseDir);
  if (!command) {
    warnings.push(`Skipping MCP server "${name}" because it has no command or URL.`);
    return null;
  }

  return {
    name,
    command,
    args: readStringArray(value.args, baseDir) ?? [],
    env: readEnvEntries(value.env, baseDir),
    cwd: readString(value.cwd, baseDir),
    ...common,
  };
}

function readGeminiMcpServerCommon(value: Record<string, unknown>, baseDir: string): Partial<{
  timeout: number;
  description: string;
  includeTools: string[];
  excludeTools: string[];
  oauth: unknown;
}> {
  const common: Partial<{
    timeout: number;
    description: string;
    includeTools: string[];
    excludeTools: string[];
    oauth: unknown;
  }> = {};
  if (typeof value.timeout === 'number') common.timeout = value.timeout;
  const description = readString(value.description, baseDir);
  if (description) common.description = description;
  const includeTools = readStringArray(value.includeTools, baseDir);
  if (includeTools) common.includeTools = includeTools;
  const excludeTools = readStringArray(value.excludeTools, baseDir);
  if (excludeTools) common.excludeTools = excludeTools;
  if (isRecord(value.oauth)) common.oauth = value.oauth;
  return common;
}

function readString(value: unknown, extensionPath?: string): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return replaceExtensionPlaceholders(value.trim(), extensionPath);
}

function readStringArray(value: unknown, extensionPath?: string): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => replaceExtensionPlaceholders(item, extensionPath));
}

function readEnvEntries(value: unknown, extensionPath?: string): Array<{ name: string; value: string }> {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name, entryValue]) => ({ name, value: replaceExtensionPlaceholders(entryValue, extensionPath) }));
}

function replaceExtensionPlaceholders(value: string, extensionPath?: string): string {
  if (!extensionPath) return value;
  return value
    .replace(/\$\{extensionPath\}/g, extensionPath)
    .replace(/\$\{\/\}/g, path.sep);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function inspectMcpServer(server: AcpMcpServer): Promise<McpServerInfo> {
  if ('type' in server) {
    if (server.type === 'tcp') {
      return {
        name: server.name,
        transport: 'tcp',
        status: 'warn',
        detail: 'Configured TCP MCP endpoint. Direct inspection is not available from CalmUI yet.',
        tcp: server.tcp,
        toolCount: 0,
        tools: [],
        action: 'openGeminiSettings',
      };
    }
    return {
      name: server.name,
      transport: server.type,
      status: 'warn',
      detail: `Configured ${server.type.toUpperCase()} MCP endpoint. Direct inspection is not available from CalmUI yet.`,
      url: server.url,
      toolCount: 0,
      tools: [],
      action: 'openGeminiSettings',
    };
  }

  if (!fs.existsSync(server.command) && (server.command.includes('/') || server.command.includes('\\'))) {
    return {
      name: server.name,
      transport: 'stdio',
      status: 'fail',
      detail: `Server command was not found at ${server.command}.`,
      command: server.command,
      args: server.args,
      toolCount: 0,
      tools: [],
      action: 'openGeminiSettings',
    };
  }

  try {
    const result = await probeStdioServer(server);
    const tools = applyToolFilters(readTools(result.toolsResult), server);
    return {
      name: server.name,
      transport: 'stdio',
      status: tools.length > 0 ? 'connected' : 'warn',
      detail: tools.length > 0
        ? 'Connected and tool metadata loaded.'
        : 'Server responded, but no tools were reported.',
      command: server.command,
      args: server.args,
      toolCount: tools.length,
      tools,
      action: tools.length > 0 ? 'refreshMcpInspector' : 'openGeminiSettings',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const authRequired = /\bauth\b|\btoken\b|\blogin\b|unauthorized|forbidden/i.test(message);
    return {
      name: server.name,
      transport: 'stdio',
      status: 'fail',
      detail: authRequired
        ? `Server requires authentication before tools can be listed: ${message}`
        : `Server probe failed: ${message}`,
      command: server.command,
      args: server.args,
      toolCount: 0,
      tools: [],
      action: authRequired ? 'openGeminiSettings' : 'refreshMcpInspector',
    };
  }
}

async function probeStdioServer(server: Extract<AcpMcpServer, { command: string }>): Promise<{
  toolsResult: unknown;
}> {
  const env = {
    ...process.env,
    ...Object.fromEntries(server.env.map(entry => [entry.name, entry.value])),
  };
  const proc = spawn(server.command, server.args, {
    env,
    cwd: server.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });

  const parser = createMcpResponseParser();
  const stderrChunks: string[] = [];
  proc.stderr.on('data', (chunk: Buffer | string) => {
    stderrChunks.push(chunk.toString());
  });

  const exitPromise = new Promise<void>((resolve, reject) => {
    proc.once('error', reject);
    proc.once('exit', (code) => {
      if (code && code !== 0) {
        reject(new Error(stderrChunks.join(' ').trim() || `process exited with code ${code}`));
        return;
      }
      resolve();
    });
  });

  const readPromise = new Promise<{ toolsResult: unknown }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out while inspecting ${server.name}. ${stderrChunks.join(' ').trim()}`.trim()));
    }, 5_000);
    const results = new Map<number, unknown>();
    const rejectOnce = (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    };

    proc.once('error', (err) => rejectOnce(err));
    proc.once('exit', (code) => {
      if (results.has(2) || code === 0 || code === null) return;
      rejectOnce(new Error(stderrChunks.join(' ').trim() || `process exited with code ${code}`));
    });

    proc.stdout.on('data', (chunk: Buffer | string) => {
      try {
        for (const msg of parser.push(chunk.toString())) {
          if (typeof msg.id !== 'number') continue;
          if (msg.error?.message) {
            rejectOnce(new Error(msg.error.message));
            return;
          }
          results.set(msg.id, msg.result);
          if (results.has(1) && results.has(2)) {
            clearTimeout(timeout);
            resolve({
              toolsResult: results.get(2),
            });
            proc.kill();
            return;
          }
        }
      } catch (err) {
        rejectOnce(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });

  writeRpc(proc.stdin, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'gemini-cli-calmui', version: '1.5.2' },
    },
  });
  writeRpc(proc.stdin, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });

  try {
    const result = await readPromise;
    return result;
  } finally {
    proc.kill();
    try {
      await exitPromise;
    } catch {
      // Ignore non-critical shutdown noise after probing.
    }
  }
}

function readTools(result: unknown): McpToolInfo[] {
  if (!result || typeof result !== 'object') return [];
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool): McpToolInfo | null => {
      if (!tool || typeof tool !== 'object') return null;
      const obj = tool as Record<string, unknown>;
      const name = typeof obj.name === 'string' ? obj.name.trim() : '';
      if (!name) return null;
      return {
        name,
        description: typeof obj.description === 'string' ? obj.description.trim() : undefined,
        inputSchema: obj.inputSchema,
      };
    })
    .filter((tool): tool is McpToolInfo => tool !== null);
}

function applyToolFilters(
  tools: McpToolInfo[],
  server: Pick<Extract<AcpMcpServer, { command: string }>, 'includeTools' | 'excludeTools'>,
): McpToolInfo[] {
  const include = server.includeTools && server.includeTools.length > 0
    ? new Set(server.includeTools)
    : null;
  const exclude = new Set(server.excludeTools ?? []);
  return tools.filter(tool => {
    if (include && !include.has(tool.name)) return false;
    return !exclude.has(tool.name);
  });
}

function writeRpc(
  stdin: NodeJS.WritableStream | null,
  message: { jsonrpc: '2.0'; id: number; method: string; params: unknown },
): void {
  if (!stdin) return;
  const body = JSON.stringify(message);
  stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}

function createMcpResponseParser(): { push(chunk: string): JsonRpcMessage[] } {
  let buffer = '';
  return {
    push(chunk: string): JsonRpcMessage[] {
      buffer += chunk;
      const messages: JsonRpcMessage[] = [];
      while (buffer.length > 0) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd >= 0) {
          const header = buffer.slice(0, headerEnd);
          const match = /content-length:\s*(\d+)/i.exec(header);
          if (!match) break;
          const length = Number(match[1]);
          const start = headerEnd + 4;
          if (buffer.length < start + length) break;
          messages.push(JSON.parse(buffer.slice(start, start + length)) as JsonRpcMessage);
          buffer = buffer.slice(start + length);
          continue;
        }

        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        messages.push(JSON.parse(line) as JsonRpcMessage);
      }
      return messages;
    },
  };
}
