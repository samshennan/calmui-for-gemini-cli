export type ChatRole = 'user' | 'assistant' | 'tool' | 'error' | 'warning';
export type ChatStatus = 'idle' | 'receiving' | 'reconnecting' | 'error';
export type ConnectionStatus = 'connected' | 'receiving' | 'reconnecting' | 'disconnected' | 'error';
export type PermissionMode = 'ask' | 'yolo';
export const MODEL_IDS = [
  'auto',
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
] as const;

export type ModelId = string;

export interface ModelOption {
  id: string;
  label: string;
}

export interface SlashCommand {
  name: string;
  description?: string;
  kind?: string;
}

export const DEFAULT_MODEL_OPTIONS: ModelOption[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' },
  { id: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
];

export const DEFAULT_SLASH_COMMANDS: SlashCommand[] = [
  { name: '/compress', description: 'Compress conversation history to save tokens' },
  { name: '/memory add <text>', description: 'Add a note to GEMINI.md memory' },
  { name: '/memory show', description: 'Print current memory' },
  { name: '/tools', description: 'List available tools' },
  { name: '/mcp list', description: 'List MCP servers' },
  { name: '/chat save <tag>', description: 'Save a checkpoint' },
  { name: '/chat list', description: 'List saved checkpoints' },
  { name: '/chat resume <tag>', description: 'Resume a saved checkpoint' },
  { name: '/restore', description: 'List or restore Gemini file checkpoints' },
  { name: '/stats', description: 'Show session stats' },
];

export function isValidModelId(value: string): value is ModelId {
  return (MODEL_IDS as readonly string[]).includes(value);
}

export interface GcloudStatus {
  account: string | null;
  project: string | null;
  errorMessage?: string;
}

export interface PermissionOption {
  optionId: string;
  label: string;
  kind?: string;
}

export interface PermissionRequest {
  toolName: string;
  args?: string;
  options: PermissionOption[];
  messageId: number | string;
  resolved?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  pending?: boolean;
  thinking?: string;
  permission?: PermissionRequest;
  changeSummary?: ChangeSummary;
  /** Per-turn search mode at the moment this turn was sent (Phase 39 W3/W4). */
  searchModeAtSend?: SearchMode;
  /** Discriminated attachment chips that rode this turn (Phase 39 W2/W3/W4). */
  attachments?: AttachmentChip[];
  /** Output of the `parseSources()` helper for assistant turns; absent when not applicable. */
  parsedSources?: ParsedSources;
}

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface ChangeSummary {
  turnId: number;
  files: ChangedFile[];
  rollbackAvailable: boolean;
  rollbackError?: string;
}

export interface ImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  data: string;
}

/**
 * Per-turn search grounding mode (Phase 39).
 *
 * `local`   — model must rely on its own knowledge / workspace tools only.
 * `grounded`— user explicitly opted into Google Search grounding for this turn.
 *
 * Persists across turns in the current session; resets to `local` on
 * New Conversation. See `.planning/phases/39-search-multimodal-turn-controls/RESEARCH.md` §2 D-02.
 */
export type SearchMode = 'local' | 'grounded';

/**
 * Discriminated union of attachment kinds shown as chips in the composer
 * and routed through ACP content blocks (Phase 39 W2). `id` is required on
 * every variant so React keys stay stable across kind transitions.
 *
 * - `image`       → existing `ImageAttachment` shape, sent as ACP `image` block.
 * - `fileRef`     → workspace file pointer, sent as ACP `resource_link`.
 * - `pdf`         → base64 PDF body, sent as ACP `resource` blob (gated by
 *                   `PromptCapabilities.embeddedContext`).
 * - `unsupported` → file type CalmUI cannot send; chip blocks Send until removed.
 */
export type AttachmentChip =
  | { kind: 'image'; id: string; name: string; mimeType: string; data: string }
  | { kind: 'fileRef'; id: string; uri: string; name: string; mimeType?: string }
  | { kind: 'pdf'; id: string; uri: string; name: string; data: string /* base64 */ }
  | { kind: 'unsupported'; id: string; name: string; reason: string };

/** Single row of a parsed `Sources:` footer. */
export interface SourceRow {
  index: number;
  title: string;
  url: string;
}

/** Return shape of the W3 `parseSources()` pure helper. */
export interface ParsedSources {
  body: string;
  sources: SourceRow[] | null;
  raw: string | null;
}

export interface UsageStats {
  totalTokens: number;
  models?: Record<string, number>;
}

export type DiagnosticsStatus = 'pass' | 'warn' | 'fail';
export type DiagnosticsAction =
  | 'runDiagnostics'
  | 'openGeminiSettings'
  | 'openVSCodeSettings'
  | 'refreshGcloud'
  | 'retryAcp';

export interface DiagnosticsCheck {
  id: string;
  label: string;
  status: DiagnosticsStatus;
  detail: string;
  fix?: string;
  action?: DiagnosticsAction;
}

export interface DiagnosticsReport {
  generatedAt: string;
  passed: number;
  total: number;
  checks: DiagnosticsCheck[];
}

/**
 * ACP `agentCapabilities.promptCapabilities` cached from the `initialize` handshake.
 *
 * All fields are optional booleans (treat absent as `false`). Older Gemini CLI
 * versions may not advertise `embeddedContext` — Phase 39 PDF chip gating relies
 * on this distinction, see `.planning/phases/39-search-multimodal-turn-controls/RESEARCH.md` §2 D-09.
 */
export interface PromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

export type McpServerStatus = 'connected' | 'warn' | 'fail';
export type McpServerTransport = 'stdio' | 'http' | 'sse' | 'tcp';
export type McpServerAction = 'refreshMcpInspector' | 'openGeminiSettings' | 'retryAcp';

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpServerInfo {
  name: string;
  transport: McpServerTransport;
  status: McpServerStatus;
  detail: string;
  command?: string;
  args?: string[];
  url?: string;
  tcp?: string;
  toolCount: number;
  tools: McpToolInfo[];
  action?: McpServerAction;
}

export interface McpInspectorReport {
  generatedAt: string;
  servers: McpServerInfo[];
  restartRequired?: boolean;
}

export type GeminiExtensionStatus = 'enabled' | 'disabled' | 'unknown';
export type GeminiExtensionSourceKind = 'user' | 'workspace';
export type GeminiExtensionContributionKind = 'mcp' | 'command' | 'context' | 'skill' | 'hook';
export type GeminiExtensionAction =
  | 'refreshExtensions'
  | 'installExtension'
  | 'enableExtension'
  | 'disableExtension'
  | 'updateExtension'
  | 'openExtensionManifest';

export interface GeminiExtensionContribution {
  kind: GeminiExtensionContributionKind;
  names: string[];
}

export interface GeminiExtensionInfo {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source?: string;
  sourceKind: GeminiExtensionSourceKind;
  path: string;
  manifestPath: string;
  status: GeminiExtensionStatus;
  contributions: GeminiExtensionContribution[];
}

export interface GeminiExtensionReport {
  generatedAt: string;
  extensions: GeminiExtensionInfo[];
  warnings: string[];
  restartRequired?: boolean;
  lastAction?: string;
}

export type MemoryStatus = 'idle' | 'loading' | 'saving' | 'error';
export type MemorySourceKind = 'project' | 'ancestor' | 'global';

export interface MemorySource {
  path: string;
  kind: MemorySourceKind;
  exists: boolean;
  content: string;
}

export interface MemoryInitProposal {
  id: string;
  targetPath: string;
  currentContent: string;
  proposedContent: string;
  createdAt: string;
}

export interface MemoryState {
  status: MemoryStatus;
  generatedAt?: string;
  sources: MemorySource[];
  error?: string;
  pendingAdd?: {
    text: string;
    targetPath: string;
  };
  initProposal?: MemoryInitProposal;
}

export type CheckpointStatus = 'idle' | 'loading' | 'saving' | 'restoring' | 'error';

export interface ManualCheckpoint {
  tag: string;
  createdAt?: string;
}

export interface GeminiRestoreCheckpoint {
  id: string;
  detail?: string;
}

export interface TurnRestorePoint {
  turnId: number;
  filesChanged: number;
  additions: number;
  deletions: number;
  rollbackAvailable: boolean;
}

export interface CheckpointState {
  status: CheckpointStatus;
  generatedAt?: string;
  nativeSessions: ChatSessionSummary[];
  manualCheckpoints: ManualCheckpoint[];
  restoreCheckpoints: GeminiRestoreCheckpoint[];
  turnRestorePoints: TurnRestorePoint[];
  dirtyWorktree: boolean;
  error?: string;
}

export interface SessionInfo {
  resolvedModel?: string;
  sessionId?: string;
}

export interface ChatState {
  status: ChatStatus;
  connection: ConnectionStatus;
  messages: ChatMessage[];
  permissionMode: PermissionMode;
  model: ModelId;
  availableModels: ModelOption[];
  availableCommands: SlashCommand[];
  gcloud: GcloudStatus;
  /**
   * Active per-turn search grounding mode (Phase 39). Required so every
   * construction site is forced to acknowledge the choice. Default `'local'`
   * is set in the W3 viewModel initializer.
   */
  searchMode: SearchMode;
  errorMessage?: string;
  usage?: UsageStats;
  session?: SessionInfo;
  diagnostics?: DiagnosticsReport;
  mcp?: McpInspectorReport;
  extensions?: GeminiExtensionReport;
  memory?: MemoryState;
  checkpoints?: CheckpointState;
  receivingStartedAt?: number;
  stalled?: boolean;
  queueLength?: number;
  context?: EditorContextState;
  /** Whether Google Search grounding is currently usable. Computed by the
   *  diagnostics `search-grounding` probe (Phase 39). Undefined when not yet
   *  evaluated (treat as available — defaults apply). */
  searchAvailable?: boolean;
  /** When `searchAvailable === false`, a one-line human reason for surfacing
   *  in the disabled Search-pill tooltip. `null` when search is available. */
  searchUnavailableReason?: string | null;
  /** Cached ACP `agentCapabilities.promptCapabilities` from the most recent
   *  `initialize` handshake. `null` before the handshake completes; field
   *  absent from older Gemini CLI versions is normalized to `false`. */
  promptCapabilities?: PromptCapabilities;
}

export interface EditorContextState {
  activeFile?: string;
  hasSelection?: boolean;
  selectionChars?: number;
  visibleFiles?: string[];
  mcpEnabled?: boolean;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  createdAt: string;
  messageCount: number;
  updatedAt?: string;
  native?: boolean;
}

export interface ChatSession extends ChatSessionSummary {
  messages: ChatMessage[];
}

// Messages FROM extension host TO webview
export type ExtensionMessage =
  | { type: 'chatState'; state: ChatState }

  | { type: 'generationDone'; exitCode: number | null }
  | { type: 'generationAborted' }
  | { type: 'insertDraftText'; text: string }
  | { type: 'openMemoryStudio'; prefill?: string }
  | { type: 'openCheckpointBrowser' }
  | { type: 'openExtensionManager' }
  | { type: 'error'; message: string };

// Messages FROM webview TO extension host
export type WebviewMessage =
  | {
      type: 'sendPrompt';
      text: string;
      searchMode: SearchMode;
      attachments?: AttachmentChip[];
      /** @deprecated remove in Wave 2 — bridge during migration to `attachments`. */
      images?: ImageAttachment[];
    }
  | { type: 'cancelGeneration' }
  | { type: 'cancelPending'; id: string }
  | { type: 'clearQueue' }
  | { type: 'clearConversation' }
  | { type: 'setPermissionMode'; mode: PermissionMode }
  | { type: 'setModel'; model: ModelId }
  /** Phase 39 W3 — webview asks the host to remember the active search mode
   *  for this session so other surfaces (diagnostics, telemetry, exports) can
   *  read it from `ChatState.searchMode`. */
  | { type: 'setSearchMode'; mode: SearchMode }
  /** Phase 39 W3 — webview asks the host to open an external URL via
   *  `vscode.env.openExternal`. Used by `SourcesSection` row clicks. */
  | { type: 'openExternal'; url: string }
  | { type: 'refreshGcloudStatus' }
  | { type: 'copyToClipboard'; text: string }
  | { type: 'showHistory' }
  | { type: 'openCheckpointBrowser' }
  | { type: 'refreshCheckpoints' }
  | { type: 'saveCheckpoint'; tag: string }
  | { type: 'resumeManualCheckpoint'; tag: string }
  | { type: 'restoreGeminiCheckpoint'; checkpointId: string }
  | { type: 'restoreNativeSession'; sessionId: string }
  | { type: 'openGeminiSettings' }
  | { type: 'openVSCodeSettings' }
  | { type: 'runDiagnostics' }
  | { type: 'retryAcp' }
  | { type: 'refreshMcpInspector' }
  | { type: 'openExtensionManager' }
  | { type: 'refreshExtensions' }
  | { type: 'installExtension'; url: string }
  | { type: 'enableExtension'; name: string }
  | { type: 'disableExtension'; name: string }
  | { type: 'updateExtension'; name: string }
  | { type: 'openExtensionManifest'; path: string }
  | { type: 'openMemoryStudio' }
  | { type: 'refreshMemory' }
  | { type: 'prepareMemoryAdd'; text: string }
  | { type: 'confirmMemoryAdd' }
  | { type: 'cancelMemoryAdd' }
  | { type: 'runMemoryInit' }
  | { type: 'acceptMemoryInit'; proposalId: string }
  | { type: 'rejectMemoryInit'; proposalId: string }
  | { type: 'openMemoryFile'; path: string }
  | { type: 'includeCurrentFile' }
  | { type: 'resolveDroppedFiles'; uris: string[] }
  | { type: 'permissionResponse'; messageId: number | string; optionId: string }
  | { type: 'stageDiffBlock'; diff: string }
  | { type: 'rollbackTurn'; turnId: number }
  | { type: 'exportConversation' }
  | { type: 'copyConversation' }
  | {
      type: 'editAndResend';
      messageId: string;
      text: string;
      searchMode: SearchMode;
      attachments?: AttachmentChip[];
      /** @deprecated remove in Wave 2 — bridge during migration to `attachments`. */
      images?: ImageAttachment[];
    }
  | { type: 'regenerateResponse'; messageId: string };
