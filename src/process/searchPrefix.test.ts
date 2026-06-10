/**
 * Phase 39 W5 — applySearchPrefix + stripSearchPrefix unit tests.
 *
 * The helper itself lives at `src/shared/searchPrefix.ts` (W3 hoisted it out of
 * `src/process/GeminiProcessAcp.ts` so the webview can import without dragging
 * the extension-host module graph). This test file lives under `src/process/`
 * per the wave 5 plan; the legacy re-export from `GeminiProcessAcp` keeps the
 * historical wire-side import path alive.
 */
import { describe, expect, it } from 'vitest';
import { applySearchPrefix, LOCAL_PREFIX, SEARCH_PREFIX } from '../shared/searchPrefix';
import { stripSearchPrefix } from '../webview/viewModel';

describe('applySearchPrefix', () => {
  it('prepends LOCAL_PREFIX in local mode and preserves the original text', () => {
    const out = applySearchPrefix('hello', 'local');
    expect(out.startsWith(LOCAL_PREFIX)).toBe(true);
    expect(out.endsWith('hello')).toBe(true);
    expect(out).toBe(`${LOCAL_PREFIX}hello`);
  });

  it('prepends SEARCH_PREFIX in grounded mode and preserves the original text', () => {
    const out = applySearchPrefix('hello', 'grounded');
    expect(out.startsWith(SEARCH_PREFIX)).toBe(true);
    expect(out.endsWith('hello')).toBe(true);
    expect(out).toBe(`${SEARCH_PREFIX}hello`);
  });

  it('returns the bare prefix (with trailing newline) for empty input', () => {
    expect(applySearchPrefix('', 'local')).toBe(LOCAL_PREFIX);
    expect(applySearchPrefix('', 'grounded')).toBe(SEARCH_PREFIX);
  });

  // Idempotency contract: the helper is intentionally NOT idempotent. The
  // wire-side caller (`buildAcpPrompt` in GeminiProcessAcp.ts) must invoke
  // exactly once per turn. If a future refactor accidentally calls the helper
  // twice, this test documents the resulting double-prefix shape so the
  // regression is loud.
  it('double-application doubles the prefix (helper is intentionally not idempotent)', () => {
    const once = applySearchPrefix('hello', 'local');
    const twice = applySearchPrefix(once, 'local');
    expect(twice).toBe(`${LOCAL_PREFIX}${LOCAL_PREFIX}hello`);
    expect(twice).not.toBe(once);
  });
});

describe('stripSearchPrefix', () => {
  it('round-trips applySearchPrefix in local mode', () => {
    const text = 'what does the codebase say about retries?';
    expect(stripSearchPrefix(applySearchPrefix(text, 'local'))).toBe(text);
  });

  it('round-trips applySearchPrefix in grounded mode', () => {
    const text = 'latest news on the React 19 release';
    expect(stripSearchPrefix(applySearchPrefix(text, 'grounded'))).toBe(text);
  });

  it('passes through text that has no recognised prefix', () => {
    expect(stripSearchPrefix('text without prefix')).toBe('text without prefix');
  });

  it('passes through empty string unchanged', () => {
    expect(stripSearchPrefix('')).toBe('');
  });
});
