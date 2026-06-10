#!/usr/bin/env node
const fs = require('fs');

const contextFile = process.env.CALMUI_CONTEXT_FILE;
let buffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drainMessages();
});

function drainMessages() {
  while (buffer.length > 0) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd >= 0) {
      const header = buffer.slice(0, headerEnd).toString('utf8');
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) return;
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (buffer.length < start + length) return;
      handleJson(buffer.slice(start, start + length).toString('utf8'));
      buffer = buffer.slice(start + length);
      continue;
    }

    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    const line = buffer.slice(0, newline).toString('utf8').trim();
    buffer = buffer.slice(newline + 1);
    if (line) handleJson(line);
  }
}

function handleJson(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (msg.id === undefined) return;
  try {
    write({ jsonrpc: '2.0', id: msg.id, result: route(msg.method, msg.params) });
  } catch (err) {
    write({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
    });
  }
}

function route(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: {
          resources: {},
          tools: {},
        },
        serverInfo: {
          name: 'calmui-context',
          version: '1.0.0',
        },
      };
    case 'tools/list':
      return {
        tools: [
          {
            name: 'calmui_editor_context',
            description: 'Get current VS Code editor context: active file path, cursor, selection, and visible open files.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
          {
            name: 'calmui_current_selection',
            description: 'Get only the selected text from the active VS Code editor, if any.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      };
    case 'tools/call':
      return callTool(params?.name);
    case 'resources/list':
      return {
        resources: [
          {
            uri: 'calmui://editor/context',
            name: 'CalmUI editor context',
            description: 'Active VS Code editor, cursor, selection, and visible open files.',
            mimeType: 'application/json',
          },
        ],
      };
    case 'resources/read':
      return {
        contents: [
          {
            uri: params?.uri ?? 'calmui://editor/context',
            mimeType: 'application/json',
            text: JSON.stringify(readContext(), null, 2),
          },
        ],
      };
    default:
      throw new Error(`Unsupported method: ${method}`);
  }
}

function callTool(name) {
  const context = readContext();
  const payload = name === 'calmui_current_selection'
    ? {
        activeFile: context.activeFile?.path ?? null,
        selection: context.activeFile?.selection ?? '',
        cursor: context.activeFile?.cursor ?? null,
      }
    : context;
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function readContext() {
  if (!contextFile) return { error: 'CALMUI_CONTEXT_FILE is not configured.' };
  try {
    return JSON.parse(fs.readFileSync(contextFile, 'utf8'));
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      activeFile: null,
      visibleFiles: [],
    };
  }
}

function write(msg) {
  const body = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}
