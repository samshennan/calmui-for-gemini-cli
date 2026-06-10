/**
 * Phase 39 W4 — Pure Markdown export builder.
 *
 * Lifted out of `ChatPanelProvider._exportAsMarkdown` so the logic is testable
 * without VS Code mocks (W5 owns the unit tests). No `vscode` imports allowed
 * in this module; if you find yourself reaching for the API, the call site is
 * wrong.
 *
 * Output shape (per `.planning/phases/39-search-multimodal-turn-controls/39-PLAN-WAVE-4.md`):
 *
 * ```markdown
 * # Conversation export
 *
 * - **Model:** gemini-2.5-pro
 * - **Default search mode:** local
 * - **Search available:** yes
 * - **Exported:** 2026-05-06T10:23:00.000Z
 *
 * ---
 *
 * ## You
 *
 * *mode: search-grounded*
 * *attachments: photo.png, @src/foo.ts*
 *
 * [user prompt text]
 *
 * ## Gemini
 *
 * *mode: search-grounded — 2 sources*
 *
 * [assistant body with [N] markers preserved]
 *
 * **Sources**
 *
 * 1. React 19 is now stable — react.dev (https://react.dev/...)
 * ```
 */

import type {
  AttachmentChip,
  ChatMessage,
  ChatState,
  SourceRow,
} from '../shared/messages';

export interface BuildMarkdownExportOptions {
  /** Injected for deterministic timestamps in tests; defaults to `new Date()`. */
  now?: Date;
}

/**
 * Build the Markdown export string for a `ChatState`.
 *
 * Filters out tool turns and pending turns (matching the historical behaviour
 * of `_exportAsMarkdown`). Returns an empty string when no exportable
 * messages remain — callers use that to suppress the save dialog / clipboard
 * write.
 */
export function buildMarkdownExport(
  state: ChatState,
  opts: BuildMarkdownExportOptions = {},
): string {
  const messages = state.messages.filter(m => m.role !== 'tool' && !m.pending);
  if (messages.length === 0) return '';

  const now = opts.now ?? new Date();
  const header = formatHeader(state, now);
  const turns = messages.map(m => formatTurn(m)).join('\n');

  return `${header}\n${turns}`;
}

// ───────────────────────── helpers ─────────────────────────

function formatHeader(state: ChatState, now: Date): string {
  const searchAvailable =
    state.searchAvailable === false ? 'no' : state.searchAvailable === true ? 'yes' : 'unknown';
  return [
    '# Conversation export',
    '',
    `- **Model:** ${state.model}`,
    `- **Default search mode:** ${state.searchMode}`,
    `- **Search available:** ${searchAvailable}`,
    `- **Exported:** ${now.toISOString()}`,
    '',
    '---',
    '',
  ].join('\n');
}

function formatTurn(m: ChatMessage): string {
  const author = roleLabel(m.role);
  const annotations: string[] = [];

  const modeLine = formatModeAnnotation(m);
  if (modeLine) annotations.push(`*${modeLine}*`);

  const attachmentsLine = formatAttachments(m.attachments);
  if (attachmentsLine) annotations.push(`*attachments: ${attachmentsLine}*`);

  const annotationBlock = annotations.length > 0 ? `${annotations.join('\n')}\n\n` : '';
  const sources = m.role === 'assistant' ? formatSourcesBlock(m.parsedSources?.sources ?? null) : '';

  return `## ${author}\n\n${annotationBlock}${m.content}\n${sources}`;
}

function roleLabel(role: ChatMessage['role']): string {
  switch (role) {
    case 'user':
      return 'You';
    case 'error':
      return 'Error';
    case 'warning':
      return 'Warning';
    default:
      return 'Gemini';
  }
}

/**
 * Returns the inner text of the `*mode: ...*` annotation (without the wrapping
 * asterisks), or `null` when no mode annotation should render.
 *
 * Per the wave doc:
 * - Renders only when `searchModeAtSend === 'grounded'`.
 * - User side: `mode: search-grounded`.
 * - Assistant with parsed sources: `mode: search-grounded — N sources`.
 * - Assistant without parsed sources: honest fallback acknowledging the model
 *   may or may not have actually invoked `google_web_search` (D-16 framing).
 */
function formatModeAnnotation(m: ChatMessage): string | null {
  if (m.searchModeAtSend !== 'grounded') return null;
  if (m.role === 'assistant') {
    const sources = m.parsedSources?.sources;
    if (sources && sources.length > 0) {
      return `mode: search-grounded — ${sources.length} ${sources.length === 1 ? 'source' : 'sources'}`;
    }
    return 'mode: search-grounded — user opted into search; model may or may not have called google_web_search';
  }
  return 'mode: search-grounded';
}

/**
 * Returns the comma-joined attachment list (without the leading `*attachments:`
 * prefix), or empty string when no attachments are present.
 */
export function formatAttachments(chips: AttachmentChip[] | undefined): string {
  if (!chips || chips.length === 0) return '';
  return chips.map(formatChip).join(', ');
}

function formatChip(chip: AttachmentChip): string {
  switch (chip.kind) {
    case 'image':
      return chip.name;
    case 'fileRef':
      // Prefer the workspace-relative pointer (`@uri-or-name`). The `uri` field
      // carries either a workspace-relative path the chip resolver populated or
      // the raw URI; either way prefixing with `@` matches the in-app chip.
      return `@${chip.uri || chip.name}`;
    case 'pdf':
      return chip.name;
    case 'unsupported':
      // Defensive: dispatch should reject these, but if one slips into a sent
      // turn we still want a non-empty rendering rather than silent omission.
      return `${chip.name} (unsupported)`;
  }
}

function formatSourcesBlock(sources: SourceRow[] | null): string {
  if (!sources || sources.length === 0) return '';
  const rows = sources
    .map(s => {
      const host = safeHost(s.url);
      const tail = host ? ` — ${host}` : '';
      return `${s.index}. ${s.title}${tail} (${s.url})`;
    })
    .join('\n');
  return `\n**Sources**\n\n${rows}\n`;
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
