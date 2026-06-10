import { describe, it, expect } from 'vitest';
import {
  getAssistantContent,
  getAvailableCommands,
  getAvailableModels,
  getInitInfo,
  getErrorEvent,
  getPermissionRequest,
  getResultUsage,
  getThinkingContent,
  getToolActivity,
  extractTokenTotal,
  firstString,
} from './parsers';

describe('getAssistantContent', () => {
  it('extracts content from a valid assistant message event', () => {
    expect(getAssistantContent({ type: 'message', role: 'assistant', content: 'Hello' }))
      .toBe('Hello');
  });

  it('returns empty string for user messages', () => {
    expect(getAssistantContent({ type: 'message', role: 'user', content: 'Hi' }))
      .toBe('');
  });

  it('returns empty string for non-message events', () => {
    expect(getAssistantContent({ type: 'init', role: 'assistant', content: 'x' }))
      .toBe('');
  });

  it('returns empty string for non-string content', () => {
    expect(getAssistantContent({ type: 'message', role: 'assistant', content: 42 }))
      .toBe('');
  });

  it('returns empty string for null/undefined/primitives', () => {
    expect(getAssistantContent(null)).toBe('');
    expect(getAssistantContent(undefined)).toBe('');
    expect(getAssistantContent('string')).toBe('');
    expect(getAssistantContent(42)).toBe('');
  });
});

describe('getInitInfo', () => {
  it('extracts model and session ID from init event', () => {
    const result = getInitInfo({ type: 'init', model: 'gemini-2.5-pro', session_id: 'abc-123' });
    expect(result).toEqual({ resolvedModel: 'gemini-2.5-pro', sessionId: 'abc-123' });
  });

  it('extracts model only when session_id is absent', () => {
    const result = getInitInfo({ type: 'init', model: 'gemini-2.5-flash' });
    expect(result).toEqual({ resolvedModel: 'gemini-2.5-flash' });
  });

  it('returns null for non-init events', () => {
    expect(getInitInfo({ type: 'message', model: 'x' })).toBeNull();
  });

  it('returns null when both model and session_id are empty/whitespace', () => {
    expect(getInitInfo({ type: 'init', model: '  ', session_id: '' })).toBeNull();
  });

  it('trims whitespace from model and session_id', () => {
    const result = getInitInfo({ type: 'init', model: '  gemini-2.5-pro  ', session_id: '  abc  ' });
    expect(result).toEqual({ resolvedModel: 'gemini-2.5-pro', sessionId: 'abc' });
  });
});

describe('getErrorEvent', () => {
  it('returns error message from error event', () => {
    expect(getErrorEvent({ type: 'error', message: 'Something broke' }))
      .toBe('Something broke');
  });

  it('falls back to error field when message is absent', () => {
    expect(getErrorEvent({ type: 'error', error: 'Fallback error' }))
      .toBe('Fallback error');
  });

  it('prepends severity when it is not "error"', () => {
    expect(getErrorEvent({ type: 'error', message: 'Oops', severity: 'warning' }))
      .toBe('[warning] Oops');
  });

  it('does not prepend severity when it IS "error"', () => {
    expect(getErrorEvent({ type: 'error', message: 'Oops', severity: 'error' }))
      .toBe('Oops');
  });

  it('returns default message when both message and error are missing', () => {
    expect(getErrorEvent({ type: 'error' }))
      .toBe('Gemini CLI reported an error.');
  });

  it('returns null for non-error events', () => {
    expect(getErrorEvent({ type: 'message', message: 'Not an error' })).toBeNull();
  });
});

describe('getResultUsage', () => {
  it('extracts total_tokens from result stats', () => {
    const result = getResultUsage({ type: 'result', stats: { total_tokens: 1500 } });
    expect(result).toEqual({ totalTokens: 1500, models: undefined });
  });

  it('extracts totalTokens (camelCase) from result stats', () => {
    const result = getResultUsage({ type: 'result', stats: { totalTokens: 2000 } });
    expect(result).toEqual({ totalTokens: 2000, models: undefined });
  });

  it('extracts per-model breakdown', () => {
    const result = getResultUsage({
      type: 'result',
      stats: {
        total_tokens: 3000,
        models: {
          'gemini-2.5-pro': { total_tokens: 2000 },
          'gemini-2.5-flash': { total_tokens: 1000 },
        },
      },
    });
    expect(result).toEqual({
      totalTokens: 3000,
      models: { 'gemini-2.5-pro': 2000, 'gemini-2.5-flash': 1000 },
    });
  });

  it('computes total from model breakdown when total_tokens is absent', () => {
    const result = getResultUsage({
      type: 'result',
      stats: {
        models: {
          'gemini-2.5-pro': { total_tokens: 800 },
          'gemini-2.5-flash': { total_tokens: 200 },
        },
      },
    });
    expect(result).toEqual({
      totalTokens: 1000,
      models: { 'gemini-2.5-pro': 800, 'gemini-2.5-flash': 200 },
    });
  });

  it('returns null for non-result events', () => {
    expect(getResultUsage({ type: 'message', stats: { total_tokens: 100 } })).toBeNull();
  });

  it('returns null when stats is missing', () => {
    expect(getResultUsage({ type: 'result' })).toBeNull();
  });

  it('returns null when stats has no token data', () => {
    expect(getResultUsage({ type: 'result', stats: {} })).toBeNull();
  });
});

describe('discovery parsers', () => {
  it('extracts available models from normalized discovery events', () => {
    expect(getAvailableModels({
      type: 'models',
      selectedModel: 'gemini-2.5-pro',
      models: [
        { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
        'gemini-custom',
      ],
    })).toEqual({
      selectedModel: 'gemini-2.5-pro',
      models: [
        { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
        { id: 'gemini-custom', label: 'Gemini Custom' },
      ],
    });
  });

  it('extracts available slash commands from normalized discovery events', () => {
    expect(getAvailableCommands({
      type: 'commands',
      commands: [
        { name: 'stats', description: 'Show stats' },
        '/compress',
      ],
    })).toEqual([
      { name: '/stats', description: 'Show stats', kind: undefined },
      { name: '/compress' },
    ]);
  });
});

describe('extractTokenTotal', () => {
  it('extracts total_tokens from object', () => {
    expect(extractTokenTotal({ total_tokens: 500 })).toBe(500);
  });

  it('extracts totalTokens (camelCase)', () => {
    expect(extractTokenTotal({ totalTokens: 600 })).toBe(600);
  });

  it('sums prompt_tokens + response_tokens', () => {
    expect(extractTokenTotal({ prompt_tokens: 100, response_tokens: 200 })).toBe(300);
  });

  it('returns raw number when entry is a number', () => {
    expect(extractTokenTotal(42)).toBe(42);
  });

  it('returns null for null/undefined/string', () => {
    expect(extractTokenTotal(null)).toBeNull();
    expect(extractTokenTotal(undefined)).toBeNull();
    expect(extractTokenTotal('not a number')).toBeNull();
  });

  it('returns null for empty object', () => {
    expect(extractTokenTotal({})).toBeNull();
  });
});

describe('getToolActivity', () => {
  it('returns "Using <name>" for tool_use events', () => {
    expect(getToolActivity({ type: 'tool_use', name: 'read_file' }))
      .toBe('Using read_file');
  });

  it('returns "Finished <name>" for tool_result events', () => {
    expect(getToolActivity({ type: 'tool_result', name: 'read_file' }))
      .toBe('Finished read_file');
  });

  it('appends status to tool_result when present', () => {
    expect(getToolActivity({ type: 'tool_result', name: 'write_file', status: 'success' }))
      .toBe('Finished write_file: success');
  });

  it('falls back to tool_name then server_name', () => {
    expect(getToolActivity({ type: 'tool_use', tool_name: 'my_tool' }))
      .toBe('Using my_tool');
    expect(getToolActivity({ type: 'tool_use', server_name: 'my_server' }))
      .toBe('Using my_server');
  });

  it('uses "tool" when no name is available', () => {
    expect(getToolActivity({ type: 'tool_use' }))
      .toBe('Using tool');
  });

  it('returns empty string for unrecognized event types', () => {
    expect(getToolActivity({ type: 'message' })).toBe('');
    expect(getToolActivity({ type: 'init' })).toBe('');
  });
});

describe('firstString', () => {
  it('returns the first non-empty string', () => {
    expect(firstString(undefined, null, '', 'hello', 'world')).toBe('hello');
  });

  it('trims the result', () => {
    expect(firstString('  padded  ')).toBe('padded');
  });

  it('skips whitespace-only strings', () => {
    expect(firstString('   ', 'valid')).toBe('valid');
  });

  it('returns null when no valid string is found', () => {
    expect(firstString(undefined, null, 42, '')).toBeNull();
  });
});

describe('getThinkingContent', () => {
  it('extracts content from agent_thought_chunk', () => {
    expect(getThinkingContent({ type: 'agent_thought_chunk', content: 'Let me think...' }))
      .toBe('Let me think...');
  });

  it('extracts content from thinking type', () => {
    expect(getThinkingContent({ type: 'thinking', text: 'Planning...' }))
      .toBe('Planning...');
  });

  it('returns empty string for non-thinking events', () => {
    expect(getThinkingContent({ type: 'message', content: 'Hello' })).toBe('');
  });

  it('returns empty string for null', () => {
    expect(getThinkingContent(null)).toBe('');
  });
});

describe('getPermissionRequest', () => {
  it('parses a permission request with options', () => {
    const result = getPermissionRequest({
      type: 'permission_request',
      toolName: 'write_file',
      args: '{"path": "/tmp/test.txt"}',
      options: [
        { optionId: 'allow', label: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', label: 'Reject', kind: 'reject_once' },
      ],
      messageId: 42,
    });
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe('write_file');
    expect(result!.options).toHaveLength(2);
    expect(result!.options[0].optionId).toBe('allow');
    expect(result!.options[0].kind).toBe('allow_once');
    expect(result!.messageId).toBe(42);
  });

  it('returns null for non-permission events', () => {
    expect(getPermissionRequest({ type: 'message', content: 'Hi' })).toBeNull();
  });

  it('returns null for null input', () => {
    expect(getPermissionRequest(null)).toBeNull();
  });

  it('handles object args by stringifying', () => {
    const result = getPermissionRequest({
      type: 'permission_request',
      tool_name: 'run_command',
      args: { cmd: 'ls' },
      options: [{ optionId: 'ok', label: 'OK' }],
      id: 7,
    });
    expect(result!.args).toContain('"cmd"');
    expect(result!.toolName).toBe('run_command');
  });
});
