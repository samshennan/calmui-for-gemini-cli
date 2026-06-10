import type * as vscode from 'vscode';
import type {
  AttachmentChip,
  ImageAttachment,
  PermissionMode,
  SearchMode,
} from '../shared/messages';

export interface GeminiSendOptions {
  model: string;
  permissionMode: PermissionMode;
  context?: GeminiPromptContext;
  /**
   * Per-turn search grounding mode (Phase 39 W2). Required so every
   * construction site is forced to acknowledge the choice. The transport
   * layer threads this through to `buildAcpPrompt` which prepends the
   * locked `[Local mode]` / `[Search mode]` prefix to the first text part.
   */
  searchMode: SearchMode;
  /**
   * Discriminated attachment chips for this turn (Phase 39 W2). When
   * present, supersedes `images` (the legacy bridge field). Each chip is
   * routed by `kind` to its ACP content block:
   *   - `image`       → ACP `image` block
   *   - `fileRef`     → ACP `resource_link` block
   *   - `pdf`         → ACP `resource` blob (BlobResourceContents)
   *   - `unsupported` → defensive throw (rejected at dispatch upstream)
   */
  attachments?: AttachmentChip[];
  /**
   * @deprecated Phase 39 W2 deprecation bridge — set via `attachments` of
   * kind `'image'` instead. Retained for one wave so partial reverts are
   * possible. W3 stops populating this field at the call sites.
   */
  images?: ImageAttachment[];
  memoryBuffer?: boolean;
}

export interface GeminiPromptContext {
  activeFile?: {
    uri: string;
    path: string;
    text: string;
    languageId?: string;
    selection?: string;
    cursor?: { line: number; character: number };
  };
}

export interface GeminiTransport extends vscode.Disposable {
  send(
    prompt: string,
    options: GeminiSendOptions,
    onChunk: (line: string, parsed: unknown) => void,
    onDone: (exitCode: number | null) => void,
    onError: (err: string) => void,
    onStderrWarning?: (warning: string) => void,
    sessionId?: string,
  ): void;

  kill(): void;
}
