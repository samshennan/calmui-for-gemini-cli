import type {
  AttachmentChip,
  ChatState,
  CheckpointState,
  DiagnosticsAction,
  DiagnosticsReport,
  GeminiExtensionReport,
  GeminiRestoreCheckpoint,
  ImageAttachment,
  ManualCheckpoint,
  McpInspectorReport,
  McpServerAction,
  MemoryState,
  ParsedSources,
  PromptCapabilities,
  SearchMode,
  SourceRow,
} from '../shared/messages';
import { LOCAL_PREFIX, SEARCH_PREFIX } from '../shared/searchPrefix';

// ───────────────────────── Phase 39 W3: search helpers ─────────────────────────
//
// Pure helpers consumed by the webview. Unit tests for these land in W5; this
// wave only exports them and threads them through the render path.

const SOURCES_FOOTER_RE = /\n\nSources:\n((?:\[\d+\][^\n]+\n?)+)\s*$/;
const SOURCES_ROW_RE = /^\[(\d+)\]\s+(.+?)\s+\((https?:\/\/[^)]+)\)\s*$/;

/**
 * Parse a trailing `Sources:` footer out of an assistant message.
 *
 * Returns the body (footer removed) plus parsed rows and the raw footer
 * string. When the footer regex doesn't match but inline `[N]` markers
 * exist, returns `{ body: text, sources: null, raw: null }` so the caller
 * skips rendering a Sources section but still shows the inline markers.
 *
 * Recognised rows are kept in `sources`; unrecognised rows are dropped from
 * `sources` but the original `raw` footer text is preserved so the
 * "View raw" toggle in the UI can still display them verbatim.
 */
export function parseSources(text: string): ParsedSources {
  const m = SOURCES_FOOTER_RE.exec(text);
  if (!m) return { body: text, sources: null, raw: null };
  const raw = m[0];
  const lines = m[1].split('\n').filter(Boolean);
  const sources: SourceRow[] = [];
  for (const line of lines) {
    const r = SOURCES_ROW_RE.exec(line);
    if (r) {
      sources.push({ index: Number(r[1]), title: r[2], url: r[3] });
    }
  }
  const body = text.slice(0, text.length - raw.length).replace(/\s+$/, '');
  return { body, sources: sources.length > 0 ? sources : null, raw };
}

/**
 * Strip the W2 LOCAL_PREFIX or SEARCH_PREFIX from the start of `text`.
 *
 * Used by the user-bubble display path so the user sees their original
 * prompt, while the wire payload still carries the prefix so Gemini honors
 * the per-turn intent.
 */
export function stripSearchPrefix(text: string): string {
  if (text.startsWith(LOCAL_PREFIX)) return text.slice(LOCAL_PREFIX.length);
  if (text.startsWith(SEARCH_PREFIX)) return text.slice(SEARCH_PREFIX.length);
  return text;
}

export const VIRTUAL_MESSAGE_HEIGHT = 180;
export const VIRTUAL_OVERSCAN = 8;
export const VIRTUAL_THRESHOLD = 50;

export interface VirtualWindow {
  enabled: boolean;
  start: number;
  end: number;
  topPadding: number;
  bottomPadding: number;
}

export function getVirtualWindow(count: number, scrollTop: number, viewportHeight: number): VirtualWindow {
  if (count <= VIRTUAL_THRESHOLD) {
    return { enabled: false, start: 0, end: count, topPadding: 0, bottomPadding: 0 };
  }

  const firstVisible = Math.floor(scrollTop / VIRTUAL_MESSAGE_HEIGHT);
  const visibleCount = Math.ceil(viewportHeight / VIRTUAL_MESSAGE_HEIGHT);
  const start = Math.max(0, firstVisible - VIRTUAL_OVERSCAN);
  const end = Math.min(count, firstVisible + visibleCount + VIRTUAL_OVERSCAN);
  return {
    enabled: true,
    start,
    end,
    topPadding: start * VIRTUAL_MESSAGE_HEIGHT,
    bottomPadding: Math.max(0, (count - end) * VIRTUAL_MESSAGE_HEIGHT),
  };
}

export type ComposerNoticeLevel = 'info' | 'warning' | 'error';

export interface ComposerNoticeInfo {
  level: ComposerNoticeLevel;
  text: string;
  action?: string;
}

export function getDiagnosticsActionLabel(action: DiagnosticsAction): string {
  switch (action) {
    case 'runDiagnostics':
      return 'Run Diagnostics';
    case 'openGeminiSettings':
      return 'Open Gemini Settings';
    case 'openVSCodeSettings':
      return 'Open Settings';
    case 'refreshGcloud':
      return 'Refresh Auth';
    case 'retryAcp':
      return 'Retry ACP';
  }
}

export function getDiagnosticsProblems(report?: DiagnosticsReport): DiagnosticsReport['checks'] {
  return report?.checks.filter(check => check.status !== 'pass') ?? [];
}

export function getMcpActionLabel(action: McpServerAction): string {
  switch (action) {
    case 'refreshMcpInspector':
      return 'Rescan';
    case 'openGeminiSettings':
      return 'Open Gemini Settings';
    case 'retryAcp':
      return 'Retry ACP';
  }
}

export function getMcpProblemCount(report?: McpInspectorReport): number {
  return report?.servers.filter(server => server.status !== 'connected').length ?? 0;
}

export function getExtensionContributionCount(report?: GeminiExtensionReport): number {
  return report?.extensions.reduce(
    (sum, extension) => sum + extension.contributions.reduce((inner, contribution) => inner + contribution.names.length, 0),
    0,
  ) ?? 0;
}

export function getExtensionSummary(report?: GeminiExtensionReport): string {
  if (!report) return 'Extension Manager not loaded yet';
  const extensionCount = report.extensions.length;
  const contributionCount = getExtensionContributionCount(report);
  const warningCount = report.warnings.length;
  const suffix = warningCount > 0 ? `, ${warningCount} warning${warningCount === 1 ? '' : 's'}` : '';
  return `${extensionCount} extension${extensionCount === 1 ? '' : 's'}, ${contributionCount} contribution${contributionCount === 1 ? '' : 's'}${suffix}`;
}

export function isSafeExtensionName(name: string): boolean {
  return /^[A-Za-z0-9._/-]{1,120}$/.test(name.trim()) && !name.includes('..');
}

export function isSafeExtensionUrl(url: string): boolean {
  const trimmed = url.trim();
  return /^https:\/\/\S{1,500}$/i.test(trimmed) || /^git@[A-Za-z0-9_.-]+:[A-Za-z0-9_.\/-]+\.git$/i.test(trimmed);
}

export function getMemorySourceLabel(kind: MemoryState['sources'][number]['kind']): string {
  switch (kind) {
    case 'project':
      return 'Project';
    case 'ancestor':
      return 'Ancestor';
    case 'global':
      return 'Global';
  }
}

export function getMemoryExistingSources(memory?: MemoryState): MemoryState['sources'] {
  return memory?.sources.filter(source => source.exists) ?? [];
}

export function memoryActionsDisabled(chatState: ChatState): boolean {
  return chatState.status === 'receiving'
    || chatState.connection === 'disconnected'
    || chatState.connection === 'error'
    || chatState.connection === 'reconnecting'
    || chatState.status === 'reconnecting';
}

export function checkpointActionsDisabled(chatState: ChatState): boolean {
  return chatState.status === 'receiving'
    || chatState.connection === 'disconnected'
    || chatState.connection === 'error'
    || chatState.connection === 'reconnecting'
    || chatState.status === 'reconnecting';
}

export function getCheckpointSummary(checkpoints?: CheckpointState): string {
  if (!checkpoints) return 'Checkpoint Browser not loaded yet';
  if (checkpoints.status === 'loading') return 'Loading checkpoints...';
  const nativeCount = checkpoints.nativeSessions.length;
  const manualCount = checkpoints.manualCheckpoints.length;
  const restoreCount = checkpoints.restoreCheckpoints.length;
  const turnCount = checkpoints.turnRestorePoints.length;
  return `${nativeCount} native, ${manualCount} saved, ${restoreCount} restore, ${turnCount} turn rollback`;
}

export function parseManualCheckpointTags(output: string): ManualCheckpoint[] {
  const seen = new Set<string>();
  const tags: ManualCheckpoint[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^(available|saved|chat|checkpoints?|tags?:\s*$|no\s+)/i.test(line)) continue;
    const match = /(?:^[-*]\s*)?(?:tag:\s*)?([A-Za-z0-9._-]{1,80})(?:\s|$)/i.exec(line);
    const tag = match?.[1];
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push({ tag });
  }
  return tags;
}

export function parseGeminiRestoreCheckpoints(output: string): GeminiRestoreCheckpoint[] {
  const seen = new Set<string>();
  const checkpoints: GeminiRestoreCheckpoint[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^(available|restore|checkpoints?|no\s+)/i.test(line)) continue;
    const idMatch = /([0-9]{4}-[0-9]{2}-[0-9]{2}T[^\s,;]+|checkpoint-[^\s,;]+|[A-Za-z0-9._-]+-[A-Za-z0-9._-]+-[A-Za-z0-9._-]+)/.exec(line);
    const id = idMatch?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    checkpoints.push({ id, detail: line === id ? undefined : line });
  }
  return checkpoints;
}

export function isSafeCheckpointTag(tag: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(tag.trim());
}

export type ContextUsageLevel = 'normal' | 'warning' | 'critical';
export type ContextSourceOrigin = 'Gemini-native' | 'MCP-served' | 'prompt-injected';

export interface ContextUsageInfo {
  limit: number;
  percentage: number;
  level: ContextUsageLevel;
  modelId: string;
  label: string;
  estimated: boolean;
}

export interface ContextSourceInfo {
  id: string;
  label: string;
  detail: string;
  origin: ContextSourceOrigin;
}

export function getContextLimit(modelId?: string): number | null {
  if (!modelId) return null;
  const normalized = modelId.toLowerCase().replace(/^models\//, '');
  if (normalized.startsWith('gemini-3')) return 1_000_000;
  if (normalized.startsWith('gemini-2.5')) return 1_048_576;
  if (normalized.startsWith('gemini-2.0')) return 1_000_000;
  return null;
}

export function buildContextUsage(
  totalTokens: number,
  activeModelId?: string,
  usageModels?: Record<string, number>,
): ContextUsageInfo | null {
  const modelId = activeModelId ?? Object.keys(usageModels ?? {})[0];
  const limit = getContextLimit(modelId);
  if (!modelId || !limit) return null;
  if (!Number.isFinite(totalTokens) || totalTokens < 0) return null;

  const percentage = Math.min(999, Math.max(0, Math.round((totalTokens / limit) * 100)));
  const level: ContextUsageLevel = percentage >= 95
    ? 'critical'
    : percentage >= 80
      ? 'warning'
      : 'normal';
  const suffix = level === 'critical' ? ' - compress' : '';
  return {
    limit,
    percentage,
    level,
    modelId,
    estimated: true,
    label: `${formatCompactTokens(totalTokens)} / ${formatCompactTokens(limit)} (${percentage}%)${suffix}`,
  };
}

export function buildContextSources({
  chatState,
  fileRefs,
  images,
}: {
  chatState: ChatState;
  fileRefs: string[];
  images: ImageAttachment[];
}): ContextSourceInfo[] {
  const sources: ContextSourceInfo[] = [];
  const existingMemory = getMemoryExistingSources(chatState.memory);
  if (existingMemory.length > 0) {
    sources.push({
      id: 'memory',
      label: 'GEMINI.md memory',
      detail: existingMemory.map(source => source.path).join(', '),
      origin: 'Gemini-native',
    });
  }
  if (chatState.context?.mcpEnabled) {
    sources.push({
      id: 'mcp-editor',
      label: 'Editor context server',
      detail: chatState.context.activeFile
        ? `Active file available: ${chatState.context.activeFile}`
        : 'CalmUI MCP context server is registered',
      origin: 'MCP-served',
    });
  }
  if (chatState.context?.activeFile) {
    sources.push({
      id: 'active-file',
      label: 'Active file',
      detail: chatState.context.activeFile,
      origin: 'prompt-injected',
    });
  }
  if (chatState.context?.hasSelection) {
    sources.push({
      id: 'selection',
      label: 'Selection',
      detail: `${chatState.context.selectionChars ?? 0} selected character${chatState.context.selectionChars === 1 ? '' : 's'}`,
      origin: chatState.context.mcpEnabled ? 'MCP-served' : 'prompt-injected',
    });
  }
  const visibleFiles = chatState.context?.visibleFiles?.filter(path => path !== chatState.context?.activeFile) ?? [];
  if (visibleFiles.length > 0) {
    sources.push({
      id: 'visible-editors',
      label: 'Open editors',
      detail: visibleFiles.join(', '),
      origin: chatState.context?.mcpEnabled ? 'MCP-served' : 'prompt-injected',
    });
  }
  if (fileRefs.length > 0) {
    sources.push({
      id: 'file-refs',
      label: 'File references',
      detail: fileRefs.join(', '),
      origin: 'prompt-injected',
    });
  }
  if (images.length > 0) {
    sources.push({
      id: 'images',
      label: 'Images',
      detail: images.map(image => image.name).join(', '),
      origin: 'Gemini-native',
    });
  }
  return sources;
}

function formatCompactTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

export function buildComposerNotice({
  chatState,
  imageInputMessage,
  connectionBlocksSend,
  sendDisabledReason,
}: {
  chatState: ChatState;
  imageInputMessage: string | null;
  connectionBlocksSend: boolean;
  sendDisabledReason?: string;
}): ComposerNoticeInfo | null {
  if (imageInputMessage) {
    return { level: 'warning', text: imageInputMessage };
  }
  if (connectionBlocksSend && sendDisabledReason) {
    return { level: chatState.connection === 'error' ? 'error' : 'warning', text: sendDisabledReason };
  }
  if (chatState.errorMessage) {
    return { level: 'error', text: chatState.errorMessage };
  }
  if (chatState.gcloud.errorMessage && !chatState.session?.resolvedModel) {
    return {
      level: 'warning',
      text: 'Google Cloud credentials need attention.',
      action: 'Run Diagnostics, or refresh Google Cloud status from the diagnostics panel.',
    };
  }
  return null;
}

export interface SendPayloadDecision {
  payload:
    | {
        text: string;
        searchMode: SearchMode;
        attachments?: AttachmentChip[];
      }
    | null;
  imageError?: string;
}

/**
 * Decide whether a draft + attachment chips can be sent and, if so, build the
 * outgoing payload.
 *
 * Phase 39 W3: legacy `images?: ImageAttachment[]` payload field is gone from
 * the webview side — every attachment now flows as an `AttachmentChip` chip.
 * Image-only sends fall back to a default prompt; an unsupported chip blocks
 * the send upstream (the composer disables Send so we never enter this path
 * with one), but we still surface a friendly error if the caller forgets.
 */
export function buildSendPayload(
  draft: string,
  attachments: AttachmentChip[],
  acpEnabled: boolean,
  searchMode: SearchMode,
): SendPayloadDecision {
  const prompt = draft.trim();
  const imageOnly = attachments.length > 0 && attachments.every(chip => chip.kind === 'image');
  if (!prompt && attachments.length === 0) return { payload: null };
  if (attachments.some(chip => chip.kind === 'image') && !acpEnabled) {
    return {
      payload: null,
      imageError: 'Image input requires ACP mode. Enable CalmUI: Use ACP to send images.',
    };
  }
  if (attachments.some(chip => chip.kind === 'unsupported')) {
    const offender = attachments.find(chip => chip.kind === 'unsupported');
    const name = offender && 'name' in offender ? offender.name : 'attachment';
    return {
      payload: null,
      imageError: `${name} is not supported by Gemini. Remove it before sending.`,
    };
  }
  return {
    payload: {
      text: prompt || (imageOnly ? 'Please analyze the attached image(s).' : ''),
      searchMode,
      attachments: attachments.length > 0 ? attachments : undefined,
    },
  };
}

/**
 * Classify a dropped or pasted file into a discriminated `AttachmentChip`.
 *
 * Phase 39 W2/W3 four-way switch:
 *   - `image/*`        → `image` chip (sends as ACP `image` content block)
 *   - `application/pdf`→ `pdf` chip when `embeddedContext === true`, else
 *                        `unsupported` chip (this Gemini CLI version cannot
 *                        accept native PDF resources)
 *   - text-like / code → `fileRef` chip (sends as ACP `resource_link`)
 *   - everything else  → `unsupported` chip (blocks Send until removed)
 *
 * The function is pure — caller handles base64 reading for `image` and `pdf`
 * before dispatching. Unit tests live in W5.
 */
export function classifyDroppedFile(
  name: string,
  mimeType: string,
  capabilities: PromptCapabilities | undefined,
  options: { id: string; uri?: string },
): AttachmentChip {
  const lowerName = name.toLowerCase();
  const lowerMime = (mimeType || '').toLowerCase();

  if (lowerMime.startsWith('image/')) {
    // Image data is filled in by the caller after FileReader resolves.
    return { kind: 'image', id: options.id, name, mimeType: mimeType || 'image/png', data: '' };
  }

  const isPdf = lowerMime === 'application/pdf' || lowerName.endsWith('.pdf');
  if (isPdf) {
    if (capabilities?.embeddedContext === true) {
      return { kind: 'pdf', id: options.id, uri: options.uri ?? '', name, data: '' };
    }
    return {
      kind: 'unsupported',
      id: options.id,
      name,
      reason: 'Native PDF requires Gemini CLI to advertise embeddedContext',
    };
  }

  const looksLikeText =
    lowerMime.startsWith('text/') ||
    lowerMime === 'application/json' ||
    lowerMime === 'application/xml' ||
    lowerMime === 'application/javascript' ||
    lowerMime === 'application/typescript' ||
    /\.(ts|tsx|js|jsx|mjs|cjs|json|md|markdown|txt|yml|yaml|toml|ini|cfg|html|htm|css|scss|sass|less|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|sh|bash|zsh|ps1|bat|cmd|sql|graphql|gql|proto|env|gitignore|dockerfile|tf|hcl|lua|r|jl|ex|exs|vue|svelte|astro|tsx?|jsonc)$/.test(lowerName);

  if (looksLikeText) {
    return {
      kind: 'fileRef',
      id: options.id,
      uri: options.uri ?? '',
      name,
      mimeType: mimeType || undefined,
    };
  }

  return {
    kind: 'unsupported',
    id: options.id,
    name,
    reason: 'Cannot be sent to Gemini',
  };
}

export function getDroppedFileUri(file: File): string | null {
  const path = (file as File & { path?: string }).path;
  if (path) return `file:///${path.replace(/\\/g, '/').replace(/^\/+/, '')}`;
  const uri = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return uri ? `file:///${uri.replace(/\\/g, '/')}` : null;
}
