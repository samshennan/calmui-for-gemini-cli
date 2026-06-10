import { describe, it, expect } from 'vitest';
import {
  adaptAcpPromptResult,
  adaptAcpAvailableCommandsUpdate,
  adaptAcpInitializeResult,
  adaptAcpSessionNewResult,
  adaptAcpSessionUpdate,
  buildAcpSelectedPermissionResult,
  parseAcpMessage,
  selectAcpPermissionOption,
} from './acp';

describe('parseAcpMessage', () => {
  it('parses a valid JSON-RPC request', () => {
    const msg = parseAcpMessage(
      '{"jsonrpc":"2.0","method":"session/new","id":1,"params":{"prompt":"hello"}}',
    );
    expect(msg).toEqual({
      jsonrpc: '2.0',
      method: 'session/new',
      id: 1,
      params: { prompt: 'hello' },
    });
  });

  it('parses a valid JSON-RPC response', () => {
    const msg = parseAcpMessage(
      '{"jsonrpc":"2.0","id":1,"result":{"status":"ok"}}',
    );
    expect(msg).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { status: 'ok' },
    });
  });

  it('parses a JSON-RPC error response', () => {
    const msg = parseAcpMessage(
      '{"jsonrpc":"2.0","id":2,"error":{"code":-32600,"message":"Invalid request"}}',
    );
    expect(msg).toEqual({
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32600, message: 'Invalid request' },
    });
  });

  it('parses a notification (no id)', () => {
    const msg = parseAcpMessage(
      '{"jsonrpc":"2.0","method":"session/update","params":{"content":"chunk"}}',
    );
    expect(msg).toEqual({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { content: 'chunk' },
    });
  });

  it('returns null for empty string', () => {
    expect(parseAcpMessage('')).toBeNull();
    expect(parseAcpMessage('   ')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseAcpMessage('not json at all')).toBeNull();
    expect(parseAcpMessage('{broken')).toBeNull();
  });

  it('returns null for valid JSON without jsonrpc field', () => {
    expect(parseAcpMessage('{"method":"foo"}')).toBeNull();
  });

  it('returns null for jsonrpc != 2.0', () => {
    expect(parseAcpMessage('{"jsonrpc":"1.0","method":"foo"}')).toBeNull();
  });

  it('tolerates leading/trailing whitespace', () => {
    const msg = parseAcpMessage('  {"jsonrpc":"2.0","method":"ping"}  ');
    expect(msg).toEqual({ jsonrpc: '2.0', method: 'ping' });
  });

  it('returns null for non-JSON startup noise from ACP stdout (Pitfall 1)', () => {
    expect(parseAcpMessage('Gemini CLI v1.0.0')).toBeNull();
    expect(parseAcpMessage('Loading configuration...')).toBeNull();
  });
});

describe('ACP adapters', () => {
  it('adapts session/new metadata to existing init shape', () => {
    expect(adaptAcpSessionNewResult({
      sessionId: 'session-1',
      models: { currentModelId: 'gemini-2.5-pro' },
    })).toEqual({
      type: 'init',
      model: 'gemini-2.5-pro',
      session_id: 'session-1',
    });
  });

  it('adapts agent message chunks to existing assistant message shape', () => {
    expect(adaptAcpSessionUpdate({
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      },
    })).toEqual([{ type: 'message', role: 'assistant', content: 'hello' }]);
  });

  it('adapts prompt quota metadata to existing result usage shape', () => {
    expect(adaptAcpPromptResult({
      stopReason: 'end_turn',
      _meta: {
        quota: {
          token_count: { input_tokens: 10, output_tokens: 5 },
          model_usage: [
            { model: 'gemini-2.5-pro', token_count: { input_tokens: 10, output_tokens: 5 } },
          ],
        },
      },
    })).toEqual({
      type: 'result',
      stats: {
        total_tokens: 15,
        models: { 'gemini-2.5-pro': { total_tokens: 15 } },
      },
    });
  });

  it('adapts initialize model catalog metadata', () => {
    expect(adaptAcpInitializeResult({
      models: {
        currentModelId: 'gemini-2.5-pro',
        availableModels: [
          { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
          'gemini-custom-preview',
        ],
      },
    })).toEqual([{
      type: 'models',
      selectedModel: 'gemini-2.5-pro',
      models: [
        { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
        { id: 'gemini-custom-preview', label: 'Gemini Custom Preview' },
      ],
    }]);
  });

  it('adapts available command updates', () => {
    expect(adaptAcpAvailableCommandsUpdate({
      commands: [
        { name: 'compress', description: 'Compress history', source: 'builtin' },
        '/stats',
      ],
    })).toEqual({
      type: 'commands',
      commands: [
        { name: '/compress', description: 'Compress history', kind: 'builtin' },
        { name: '/stats' },
      ],
    });
  });

  it('adapts live usage from session/update quota metadata', () => {
    expect(adaptAcpSessionUpdate({
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
        quota: {
          token_count: { input_tokens: 4, output_tokens: 2 },
        },
      },
    })).toEqual([
      { type: 'result', stats: { total_tokens: 6 } },
      { type: 'message', role: 'assistant', content: 'hello' },
    ]);
  });

  it('selects reject once for ask mode permission requests', () => {
    expect(selectAcpPermissionOption({
      options: [
        { optionId: 'proceed_once', kind: 'allow_once' },
        { optionId: 'cancel', kind: 'reject_once' },
      ],
    }, 'ask')).toBe('cancel');
  });

  it('selects allow once for yolo mode permission requests', () => {
    expect(selectAcpPermissionOption({
      options: [
        { optionId: 'proceed_always', kind: 'allow_always' },
        { optionId: 'proceed_once', kind: 'allow_once' },
        { optionId: 'cancel', kind: 'reject_once' },
      ],
    }, 'yolo')).toBe('proceed_once');
  });

  it('builds the nested permission result shape expected by Gemini CLI', () => {
    expect(buildAcpSelectedPermissionResult('proceed_once')).toEqual({
      outcome: { outcome: 'selected', optionId: 'proceed_once' },
    });
  });
});
