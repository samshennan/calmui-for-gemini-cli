/**
 * Phase 39 W5 — buildMarkdownExport unit tests.
 *
 * The exporter is intentionally pure (no `vscode` imports), so these tests
 * only need to feed it a `ChatState` and a pinned `now` Date. We build a
 * minimal `makeState()` helper rather than populating every required field;
 * the exporter only reads `messages`, `model`, `searchMode`, and
 * `searchAvailable`, so a tight cast keeps the fixtures readable.
 */
import { describe, expect, it } from 'vitest';
import type { AttachmentChip, ChatMessage, ChatState } from '../shared/messages';
import { buildMarkdownExport } from './exportMarkdown';

const PINNED_NOW = new Date('2026-05-06T10:00:00.000Z');

function makeState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    status: 'idle',
    connection: 'connected',
    messages: [],
    permissionMode: 'ask',
    model: 'gemini-2.5-pro',
    availableModels: [],
    availableCommands: [],
    gcloud: { account: null, project: null },
    searchMode: 'local',
    searchAvailable: true,
    ...overrides,
  };
}

function userMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'u1',
    role: 'user',
    content: 'hello world',
    ...overrides,
  };
}

function assistantMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'a1',
    role: 'assistant',
    content: 'hi back',
    ...overrides,
  };
}

describe('buildMarkdownExport', () => {
  it('returns empty string for an empty conversation', () => {
    expect(buildMarkdownExport(makeState({ messages: [] }), { now: PINNED_NOW })).toBe('');
  });

  it('emits header + ## You for a single user-only turn with no annotations', () => {
    const state = makeState({
      messages: [userMsg({ content: 'plain prompt' })],
    });
    const out = buildMarkdownExport(state, { now: PINNED_NOW });

    expect(out).toContain('# Conversation export');
    expect(out).toContain('- **Model:** gemini-2.5-pro');
    expect(out).toContain('- **Default search mode:** local');
    expect(out).toContain('- **Search available:** yes');
    expect(out).toContain('- **Exported:** 2026-05-06T10:00:00.000Z');
    expect(out).toContain('## You');
    expect(out).toContain('plain prompt');
    // No mode or attachment annotation for a vanilla local-mode user turn.
    expect(out).not.toMatch(/\*mode:/);
    expect(out).not.toMatch(/\*attachments:/);
  });

  it('renders search-grounded annotation + Sources block for grounded assistant with parsed sources', () => {
    const state = makeState({
      messages: [
        assistantMsg({
          searchModeAtSend: 'grounded',
          parsedSources: {
            body: 'body [1][2]',
            raw: 'raw',
            sources: [
              { index: 1, title: 'React 19', url: 'https://react.dev/blog/2024/12/05/react-19' },
              { index: 2, title: 'React Compiler', url: 'https://react.dev/learn/react-compiler' },
            ],
          },
          content: 'body [1][2]',
        }),
      ],
    });
    const out = buildMarkdownExport(state, { now: PINNED_NOW });

    expect(out).toContain('*mode: search-grounded — 2 sources*');
    expect(out).toContain('**Sources**');
    expect(out).toMatch(/1\. React 19[^\n]* \(https:\/\/react\.dev\/blog\/2024\/12\/05\/react-19\)/);
    expect(out).toMatch(/2\. React Compiler[^\n]* \(https:\/\/react\.dev\/learn\/react-compiler\)/);
  });

  it('renders the honest fallback annotation for grounded assistant with no parsed sources', () => {
    const state = makeState({
      messages: [
        assistantMsg({
          searchModeAtSend: 'grounded',
          parsedSources: undefined,
          content: 'body without parsed sources',
        }),
      ],
    });
    const out = buildMarkdownExport(state, { now: PINNED_NOW });

    expect(out).toContain('*mode: search-grounded — user opted into search; model may or may not have called google_web_search*');
    // No spurious **Sources** block when there are no sources.
    expect(out).not.toContain('**Sources**');
  });

  it('renders mixed-attachment user turn with image, fileRef, and pdf chips', () => {
    const attachments: AttachmentChip[] = [
      { kind: 'image', id: 'i1', name: 'photo.png', mimeType: 'image/png', data: 'base64' },
      { kind: 'fileRef', id: 'f1', uri: 'src/foo.ts', name: 'foo.ts' },
      { kind: 'pdf', id: 'p1', uri: 'file:///abs/spec.pdf', name: 'spec.pdf', data: 'base64' },
    ];
    const state = makeState({
      messages: [userMsg({ attachments })],
    });
    const out = buildMarkdownExport(state, { now: PINNED_NOW });

    expect(out).toContain('*attachments: photo.png, @src/foo.ts, spec.pdf*');
  });

  it('uses the injected `now` Date for a deterministic header timestamp', () => {
    const pinned = new Date('2026-05-06T10:00:00.000Z');
    const out = buildMarkdownExport(
      makeState({ messages: [userMsg()] }),
      { now: pinned },
    );
    expect(out).toContain('- **Exported:** 2026-05-06T10:00:00.000Z');
  });

  it('filters out tool turns and pending turns', () => {
    const state = makeState({
      messages: [
        userMsg({ id: 'u1', content: 'real user turn' }),
        { id: 't1', role: 'tool', content: 'tool result content' } as ChatMessage,
        { id: 'a-pending', role: 'assistant', content: 'streaming...', pending: true },
        assistantMsg({ id: 'a1', content: 'final assistant turn' }),
      ],
    });
    const out = buildMarkdownExport(state, { now: PINNED_NOW });

    expect(out).toContain('real user turn');
    expect(out).toContain('final assistant turn');
    expect(out).not.toContain('tool result content');
    expect(out).not.toContain('streaming...');
  });
});
