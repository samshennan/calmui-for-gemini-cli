/**
 * Phase 39 — locked prompt prefixes for the per-turn Local/Search toggle.
 *
 * Lives in `src/shared` (not `src/process`) so the webview can import the
 * constants without dragging the extension-host module graph into the
 * webview bundle. Wave 2 originally exported these from
 * `src/process/GeminiProcessAcp.ts`; Wave 3 hoists them here per the
 * `src/webview` ↛ `src/process` boundary rule.
 *
 * - `LOCAL_PREFIX`   — instruct the model to ignore `google_web_search`.
 * - `SEARCH_PREFIX`  — invite use of `google_web_search` and require citations.
 * - `applySearchPrefix(text, mode)` — pure helper that prepends the right one.
 *
 * The user-bubble display strips whichever prefix is present (W3 Task 3.5)
 * so the user sees their original prompt; the wire payload retains it so
 * Gemini honors the per-turn intent.
 */
import type { SearchMode } from './messages';

export const LOCAL_PREFIX =
  '[Local mode] Do not use the google_web_search tool for this turn — answer from the codebase, attached context, and your training only.\n\n';

export const SEARCH_PREFIX =
  '[Search mode] You may use the google_web_search tool to look up current information. When you do, cite sources.\n\n';

/** Pure: prepend the locked prefix string for the active search mode. */
export function applySearchPrefix(text: string, mode: SearchMode): string {
  return (mode === 'grounded' ? SEARCH_PREFIX : LOCAL_PREFIX) + text;
}
