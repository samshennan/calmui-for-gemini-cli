import React, { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';
import {
  DEFAULT_MODEL_OPTIONS,
  DEFAULT_SLASH_COMMANDS,
  type AttachmentChip,
  type ChatMessage,
  type ChatState,
  type CheckpointState,
  type DiagnosticsAction,
  type DiagnosticsReport,
  type ExtensionMessage,
  type GeminiExtensionAction,
  type GeminiExtensionReport,
  type ImageAttachment,
  type McpInspectorReport,
  type McpServerAction,
  type ParsedSources,
  type PermissionOption,
  type PermissionMode,
  type SearchMode,
  type SlashCommand,
  type WebviewMessage,
} from '../shared/messages';
import {
  buildComposerNotice,
  buildContextSources,
  buildContextUsage,
  checkpointActionsDisabled,
  classifyDroppedFile,
  getDiagnosticsActionLabel,
  getDiagnosticsProblems,
  getExtensionSummary,
  getCheckpointSummary,
  getMcpActionLabel,
  getMcpProblemCount,
  getMemoryExistingSources,
  getMemorySourceLabel,
  memoryActionsDisabled,
  buildSendPayload,
  getDroppedFileUri,
  getVirtualWindow,
  parseSources,
  stripSearchPrefix,
  type ContextSourceOrigin,
  type ContextSourceInfo,
  type ContextUsageInfo,
} from './viewModel';
import { SourcesSection } from './components/SourcesSection';
import { SketchCanvas } from './components/SketchCanvas';

// acquireVsCodeApi() is injected by VS Code at runtime - not importable as a module
declare function acquireVsCodeApi(): {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

const logoUri = document.querySelector('meta[name="calmui-logo"]')?.getAttribute('content') ?? '';

const initialChatState: ChatState = {
  status: 'idle',
  connection: 'connected',
  messages: [],
  permissionMode: 'ask',
  model: 'gemini-2.5-pro',
  availableModels: DEFAULT_MODEL_OPTIONS,
  availableCommands: DEFAULT_SLASH_COMMANDS,
  gcloud: {
    account: null,
    project: null,
  },
  // Phase 39 W3: searchMode defaults to 'local' on first launch / New Conversation
  // (D-02). The user must explicitly opt into Search via the segmented pill.
  searchMode: 'local',
};

function freshAttachmentId(): string {
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

class ErrorBoundary extends React.Component<
  { children: ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, errorMessage: (error.message || '').slice(0, 200) };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ERROR] React render crash:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '2rem 1rem',
          textAlign: 'center',
          color: 'var(--vscode-errorForeground)',
        }}>
          <h3 style={{ margin: '0 0 8px' }}>Something went wrong</h3>
          <p style={{
            color: 'var(--vscode-descriptionForeground)',
            fontSize: '0.85em',
            margin: '0 0 16px',
            wordBreak: 'break-word',
          }}>
            {this.state.errorMessage}
          </p>
          <button
            onClick={() => location.reload()}
            style={{
              padding: '6px 16px',
              color: 'var(--vscode-button-foreground)',
              background: 'var(--vscode-button-background)',
              border: '1px solid var(--vscode-button-border, transparent)',
              borderRadius: '4px',
              cursor: 'pointer',
              font: 'inherit',
            }}
          >
            Reload panel
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  const [chatState, setChatState] = useState<ChatState>(initialChatState);
  const [draft, setDraft] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  const [showContextDashboard, setShowContextDashboard] = useState(false);
  const [showMcpInspector, setShowMcpInspector] = useState(false);
  const [showExtensions, setShowExtensions] = useState(false);
  const [memoryDraft, setMemoryDraft] = useState('');
  const [checkpointTag, setCheckpointTag] = useState('');
  const [extensionUrl, setExtensionUrl] = useState('');
  const [slashIndex, setSlashIndex] = useState(0);
  const [attachments, setAttachments] = useState<AttachmentChip[]>([]);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [imageInputMessage, setImageInputMessage] = useState<string | null>(null);
  const [dismissedNotice, setDismissedNotice] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [showSketch, setShowSketch] = useState(false);
  const [virtualScroll, setVirtualScroll] = useState({ top: 0, height: 600 });
  const [showMenu, setShowMenu] = useState(false);
  // Advanced composer controls (model, search mode, sketch) are hidden by
  // default for a calm baseline; the choice persists across webview reloads.
  const [advancedControls, setAdvancedControls] = useState<boolean>(() => {
    const saved = vscode.getState() as { advancedControls?: boolean } | undefined;
    return saved?.advancedControls === true;
  });
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const transcriptNearBottomRef = useRef(true);

  const toggleAdvancedControls = useCallback(() => {
    setAdvancedControls(prev => {
      const next = !prev;
      const saved = (vscode.getState() as Record<string, unknown> | undefined) ?? {};
      vscode.setState({ ...saved, advancedControls: next });
      return next;
    });
  }, []);

  useEffect(() => {
    if (!showMenu) return;
    const wrap = menuRef.current;
    const menuItems = () =>
      Array.from(wrap?.querySelectorAll<HTMLButtonElement>('.overflow-menu .menu-item:not(:disabled)') ?? []);
    menuItems()[0]?.focus();
    const onPointerDown = (event: MouseEvent) => {
      if (wrap && !wrap.contains(event.target as Node)) {
        setShowMenu(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowMenu(false);
        wrap?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.focus();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
      const items = menuItems();
      if (items.length === 0) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'ArrowDown'
        ? items[(index + 1) % items.length]
        : event.key === 'ArrowUp'
          ? items[(index - 1 + items.length) % items.length]
          : event.key === 'Home'
            ? items[0]
            : items[items.length - 1];
      next.focus();
    };
    // Close when focus tabs out of the menu entirely (menus must not linger
    // once keyboard focus has moved on).
    const onFocusOut = () => {
      requestAnimationFrame(() => {
        if (wrap && document.activeElement && document.activeElement !== document.body && !wrap.contains(document.activeElement)) {
          setShowMenu(false);
        }
      });
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey);
    wrap?.addEventListener('focusout', onFocusOut);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey);
      wrap?.removeEventListener('focusout', onFocusOut);
    };
  }, [showMenu]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as ExtensionMessage;
      switch (msg.type) {
        case 'chatState':
          setChatState(prev => {
            // Reset dismissed notice when connection state changes
            if (prev.connection !== msg.state.connection) {
              setDismissedNotice(false);
            }
            return msg.state;
          });
          break;
        case 'generationAborted':
          setChatState(prev => ({ ...prev, status: 'idle' }));
          break;
        case 'insertDraftText': {
          // Extract @-references into file-ref attachment chips instead of raw draft text
          const refs = msg.text.match(/@\S+/g);
          if (refs && refs.length > 0) {
            setAttachments(prev => {
              const next = [...prev];
              const existingNames = new Set(
                next.filter((c): c is Extract<AttachmentChip, { kind: 'fileRef' }> => c.kind === 'fileRef')
                    .map(c => c.name),
              );
              for (const ref of refs) {
                const name = ref.startsWith('@') ? ref.slice(1) : ref;
                if (existingNames.has(name)) continue;
                existingNames.add(name);
                next.push({ kind: 'fileRef', id: freshAttachmentId(), uri: '', name });
              }
              return next;
            });
            const textWithoutRefs = msg.text.replace(/@\S+/g, '');
            if (textWithoutRefs.trim()) {
              setDraft(prev => `${prev}${textWithoutRefs}`);
            }
          } else {
            setDraft(prev => `${prev}${msg.text}`);
          }
          requestAnimationFrame(() => textareaRef.current?.focus());
          break;
        }
        case 'openMemoryStudio':
          setShowMemory(true);
          if (msg.prefill) setMemoryDraft(msg.prefill);
          break;
        case 'openCheckpointBrowser':
          setShowCheckpoints(true);
          break;
        case 'openExtensionManager':
          setShowExtensions(true);
          break;
        case 'error':
          setChatState(prev => ({ ...prev, status: 'error', errorMessage: msg.message }));
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    // Only auto-scroll if user was already near the bottom before this render.
    if (transcriptNearBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, [chatState.messages]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  const sendPrompt = useCallback(() => {
    const decision = buildSendPayload(
      draft,
      attachments,
      Boolean(chatState.context?.mcpEnabled),
      chatState.searchMode,
    );
    if (decision.imageError) {
      setImageInputMessage(decision.imageError);
      return;
    }
    if (!decision.payload) return;
    setLastSentPrompt({ text: draft.trim(), attachments: [...attachments] });
    if (editingMessageId) {
      vscode.postMessage({ type: 'editAndResend', messageId: editingMessageId, ...decision.payload });
      setEditingMessageId(null);
    } else {
      vscode.postMessage({ type: 'sendPrompt', ...decision.payload });
    }
    setDraft('');
    setAttachments([]);
    setImageInputMessage(null);
    textareaRef.current?.focus();
  }, [chatState.context?.mcpEnabled, chatState.searchMode, draft, editingMessageId, attachments]);

  const handleSubmit = useCallback((event: React.FormEvent) => {
    event.preventDefault();
    sendPrompt();
  }, [sendPrompt]);

  const handleStop = useCallback(() => {
    vscode.postMessage({ type: 'cancelGeneration' });
  }, []);

  const handleClearQueue = useCallback(() => {
    vscode.postMessage({ type: 'clearQueue' });
  }, []);

  const handleNewConversation = useCallback(() => {
    vscode.postMessage({ type: 'clearConversation' });
    setDraft('');
    setAttachments([]);
  }, []);

  const handlePermissionModeChange = useCallback((mode: PermissionMode) => {
    vscode.postMessage({ type: 'setPermissionMode', mode });
  }, []);

  const handleModelChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
    vscode.postMessage({ type: 'setModel', model: event.target.value });
  }, []);

  const handleRefreshGcloud = useCallback(() => {
    vscode.postMessage({ type: 'refreshGcloudStatus' });
  }, []);

  const handleShowHistory = useCallback(() => {
    vscode.postMessage({ type: 'showHistory' });
  }, []);

  const handleOpenSettings = useCallback(() => {
    vscode.postMessage({ type: 'openGeminiSettings' });
  }, []);

  const handleRunDiagnostics = useCallback(() => {
    setShowDiagnostics(true);
    vscode.postMessage({ type: 'runDiagnostics' });
  }, []);

  const handleOpenMemory = useCallback(() => {
    setShowMemory(value => !value);
    vscode.postMessage({ type: 'openMemoryStudio' });
  }, []);

  const handleOpenCheckpoints = useCallback(() => {
    setShowCheckpoints(value => !value);
    vscode.postMessage({ type: 'openCheckpointBrowser' });
  }, []);

  const handleOpenContextDashboard = useCallback(() => {
    setShowContextDashboard(value => !value);
  }, []);

  const handleOpenMcpInspector = useCallback(() => {
    setShowMcpInspector(value => !value);
    vscode.postMessage({ type: 'refreshMcpInspector' });
  }, []);

  const handleOpenExtensions = useCallback(() => {
    setShowExtensions(value => !value);
    vscode.postMessage({ type: 'openExtensionManager' });
  }, []);

  const handleCompressContext = useCallback(() => {
    // /compress is a CalmUI-managed slash command that ignores the search-mode
    // prefix on the receiving side, but the WebviewMessage shape still
    // requires `searchMode` (Phase 39 W2 contract). Send the active mode.
    vscode.postMessage({ type: 'sendPrompt', text: '/compress', searchMode: chatState.searchMode });
  }, [chatState.searchMode]);

  const handleDiagnosticAction = useCallback((action: DiagnosticsAction) => {
    switch (action) {
      case 'runDiagnostics':
        setShowDiagnostics(true);
        vscode.postMessage({ type: 'runDiagnostics' });
        break;
      case 'openGeminiSettings':
        vscode.postMessage({ type: 'openGeminiSettings' });
        break;
      case 'openVSCodeSettings':
        vscode.postMessage({ type: 'openVSCodeSettings' });
        break;
      case 'refreshGcloud':
        vscode.postMessage({ type: 'refreshGcloudStatus' });
        setShowDiagnostics(true);
        vscode.postMessage({ type: 'runDiagnostics' });
        break;
      case 'retryAcp':
        vscode.postMessage({ type: 'retryAcp' });
        break;
    }
  }, []);

  const handleMcpAction = useCallback((action: McpServerAction) => {
    switch (action) {
      case 'refreshMcpInspector':
        vscode.postMessage({ type: 'refreshMcpInspector' });
        break;
      case 'openGeminiSettings':
        vscode.postMessage({ type: 'openGeminiSettings' });
        break;
      case 'retryAcp':
        vscode.postMessage({ type: 'retryAcp' });
        break;
    }
  }, []);

  const handleExtensionAction = useCallback((action: GeminiExtensionAction, value?: string) => {
    switch (action) {
      case 'refreshExtensions':
        vscode.postMessage({ type: 'refreshExtensions' });
        break;
      case 'installExtension':
        vscode.postMessage({ type: 'installExtension', url: value ?? '' });
        setExtensionUrl('');
        break;
      case 'enableExtension':
        vscode.postMessage({ type: 'enableExtension', name: value ?? '' });
        break;
      case 'disableExtension':
        vscode.postMessage({ type: 'disableExtension', name: value ?? '' });
        break;
      case 'updateExtension':
        vscode.postMessage({ type: 'updateExtension', name: value ?? '' });
        break;
      case 'openExtensionManifest':
        vscode.postMessage({ type: 'openExtensionManifest', path: value ?? '' });
        break;
    }
  }, []);

  const handleIncludeCurrentFile = useCallback(() => {
    vscode.postMessage({ type: 'includeCurrentFile' });
  }, []);

  const addImageFiles = useCallback(async (files: FileList | File[]) => {
    const incoming = Array.from(files).filter(file => file.type.startsWith('image/'));
    if (incoming.length === 0) return;
    if (!chatState.context?.mcpEnabled) {
      setImageInputMessage('Image input requires ACP mode. Enable CalmUI: Use ACP to send images.');
      return;
    }
    const existingImageCount = attachments.filter(c => c.kind === 'image').length;
    const remainingSlots = Math.max(0, 5 - existingImageCount);
    const limited = incoming.slice(0, remainingSlots);
    if (limited.length < incoming.length) {
      setImageInputMessage('CalmUI supports up to 5 images per message.');
    } else {
      setImageInputMessage(null);
    }
    const newImages = await Promise.all(limited.map(readImageAttachment));
    setAttachments(prev => [
      ...prev,
      ...newImages.map((img): AttachmentChip => ({
        kind: 'image',
        id: img.id,
        name: img.name,
        mimeType: img.mimeType,
        data: img.data,
      })),
    ]);
  }, [attachments, chatState.context?.mcpEnabled]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(chip => chip.id !== id));
  }, []);

  const handleDroppedFiles = useCallback((files: FileList | File[]) => {
    const allFiles = Array.from(files);
    const imageFiles = allFiles.filter(file => file.type.startsWith('image/'));
    const otherFiles = allFiles.filter(file => !file.type.startsWith('image/'));
    if (imageFiles.length > 0) {
      void addImageFiles(imageFiles);
    }
    if (otherFiles.length === 0) return;

    const uris = otherFiles
      .map(file => getDroppedFileUri(file))
      .filter((uri): uri is string => Boolean(uri));
    if (uris.length > 0) {
      // Host resolves to workspace-relative @-refs; webview reflects them as
      // fileRef chips via the `insertDraftText` message handler.
      vscode.postMessage({ type: 'resolveDroppedFiles', uris });
      return;
    }

    // Fallback: classify each file with the W3 four-way switch (image / pdf /
    // fileRef / unsupported). Used when we cannot get a workspace-relative
    // path from the host (drag from outside the workspace, etc.).
    const newChips: AttachmentChip[] = [];
    for (const file of otherFiles) {
      const chip = classifyDroppedFile(
        file.name,
        file.type,
        chatState.promptCapabilities,
        { id: freshAttachmentId() },
      );
      newChips.push(chip);
    }
    if (newChips.length > 0) {
      setAttachments(prev => [...prev, ...newChips]);
    }
  }, [addImageFiles, chatState.promptCapabilities]);

  useEffect(() => {
    const hasDraggedFiles = (dataTransfer: DataTransfer | null): boolean => {
      if (!dataTransfer) return false;
      if (dataTransfer.files.length > 0) return true;
      return Array.from(dataTransfer.items).some(item => item.kind === 'file');
    };

    const handleDragOver = (event: DragEvent) => {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
      setDragActive(true);
    };

    const handleDragLeave = (event: DragEvent) => {
      if (event.target === document || event.target === document.body || event.relatedTarget === null) {
        setDragActive(false);
      }
    };

    const handleDrop = (event: DragEvent) => {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      setDragActive(false);
      if (event.dataTransfer?.files.length) {
        handleDroppedFiles(event.dataTransfer.files);
      }
    };

    window.addEventListener('dragenter', handleDragOver, true);
    window.addEventListener('dragover', handleDragOver, true);
    window.addEventListener('dragleave', handleDragLeave, true);
    window.addEventListener('drop', handleDrop, true);
    return () => {
      window.removeEventListener('dragenter', handleDragOver, true);
      window.removeEventListener('dragover', handleDragOver, true);
      window.removeEventListener('dragleave', handleDragLeave, true);
      window.removeEventListener('drop', handleDrop, true);
    };
  }, [handleDroppedFiles]);

  const connectionStatus = chatState.status === 'receiving'
    ? 'receiving'
    : chatState.status === 'error'
      ? 'error'
      : chatState.connection;
  const statusLabel = chatState.status === 'receiving'
    ? 'Receiving...'
    : {
        connected: 'Ready',
        receiving: 'Receiving...',
        reconnecting: 'Reconnecting...',
        disconnected: 'Disconnected',
        error: 'Error',
      }[connectionStatus];
  const connectionBlocksSend = chatState.connection === 'disconnected'
    || chatState.connection === 'error'
    || chatState.connection === 'reconnecting'
    || chatState.status === 'reconnecting';
  const unsupportedAttachment = attachments.find(
    (c): c is Extract<AttachmentChip, { kind: 'unsupported' }> => c.kind === 'unsupported',
  );
  const hasUnsupportedAttachment = Boolean(unsupportedAttachment);
  const unsupportedDisabledReason = unsupportedAttachment
    ? `${unsupportedAttachment.name} is not supported by Gemini. Remove it before sending.`
    : undefined;
  const sendDisabledReason = connectionBlocksSend
    ? 'Gemini ACP is disconnected. Wait for the status to return to Ready, then send again.'
    : undefined;
  const rawComposerNotice = buildComposerNotice({
    chatState,
    imageInputMessage,
    connectionBlocksSend,
    sendDisabledReason,
  });
  const composerNotice = dismissedNotice ? null : rawComposerNotice;

  const modelOptions = chatState.availableModels.length > 0
    ? chatState.availableModels
    : DEFAULT_MODEL_OPTIONS;
  const commands = chatState.availableCommands.length > 0
    ? chatState.availableCommands
    : DEFAULT_SLASH_COMMANDS;
  const slashQuery = getSlashQuery(draft);
  const slashMatches = slashQuery === null
    ? []
    : commands
      .filter(command => command.name.toLowerCase().includes(slashQuery.toLowerCase()))
      .slice(0, 8);
  const showSlashPopover = slashMatches.length > 0;
  const activeModelId = chatState.session?.resolvedModel ?? (chatState.model === 'auto' ? undefined : chatState.model);
  const contextUsage = chatState.usage
    ? buildContextUsage(chatState.usage.totalTokens, activeModelId, chatState.usage.models)
    : null;
  // Derive legacy `fileRefs` / `images` shapes from the unified attachments
  // array so the existing context-dashboard view helper keeps working.
  const fileRefs = attachments
    .filter((c): c is Extract<AttachmentChip, { kind: 'fileRef' }> => c.kind === 'fileRef')
    .map(c => `@${c.name}`);
  const imagesForContext: ImageAttachment[] = attachments
    .filter((c): c is Extract<AttachmentChip, { kind: 'image' }> => c.kind === 'image')
    .map(c => ({ id: c.id, name: c.name, mimeType: c.mimeType, data: c.data }));
  const contextSources = buildContextSources({ chatState, fileRefs, images: imagesForContext });
  const transcriptMessages = chatState.messages.filter(message => message.role !== 'tool' || message.permission);
  const virtualWindow = getVirtualWindow(transcriptMessages.length, virtualScroll.top, virtualScroll.height);
  const renderedMessages = transcriptMessages.slice(virtualWindow.start, virtualWindow.end);
  const lastAssistantId = chatState.status !== 'receiving'
    ? [...transcriptMessages].reverse().find(m => m.role === 'assistant')?.id ?? null
    : null;
  const diagnosticProblems = getDiagnosticsProblems(chatState.diagnostics);
  const mcpProblemCount = getMcpProblemCount(chatState.mcp);
  const memoryDisabled = memoryActionsDisabled(chatState);
  const checkpointsDisabled = checkpointActionsDisabled(chatState);
  const lastAssistantMessage = [...transcriptMessages].reverse().find(message => message.role === 'assistant' && message.content.trim());

  useEffect(() => {
    if (editingMessageId && !chatState.messages.some(m => m.id === editingMessageId)) {
      setEditingMessageId(null);
    }
  }, [chatState.messages, editingMessageId]);

  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  const acceptSlashCommand = useCallback((command: SlashCommand) => {
    setDraft(`${command.name} `);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  // Last sent prompt for Up-arrow recall
  const [lastSentPrompt, setLastSentPrompt] = useState<{
    text: string;
    attachments: AttachmentChip[];
  } | null>(null);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Escape while receiving = cancel generation
      if (e.key === 'Escape' && chatState.status === 'receiving') {
        e.preventDefault();
        vscode.postMessage({ type: 'cancelGeneration' });
        return;
      }
      // Ctrl+L / Cmd+K = new conversation
      if ((e.key === 'l' && (e.ctrlKey || e.metaKey)) || (e.key === 'k' && e.metaKey)) {
        e.preventDefault();
        if (chatState.messages.length > 0) {
          vscode.postMessage({ type: 'clearConversation' });
        }
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [chatState.status, chatState.messages.length]);

  // Rotating "stuff" messages for thinking animation
  const stuffMessages = [
    '...doing stuff...', '...doing some other stuff...', '...unstuffing...',
    '...stuffing...', '...stuff...', '...more stuff...', '...less stuff...',
    '...stuff this...', '...stuff that...', '...stuffed up...', '...stuffed down...',
    '...thinking stuff...', '...planning stuff...', '...packing stuff...',
    '...unpacking stuff...', '...to stuff.. or not to stuff... that is the question...',
    '...stuffed...', '...stuffable...', '...stuffed out...', '...stuffacious...',
    '...sorting through stuff...', '...rearranging stuff...', '...finding the stuff...',
    '...fluffing the stuff...', '...de-stuffing...', '...re-stuffing...',
    '...stuffing the turkey...', '...stuff-wrangling...',
    '...collecting stuff...', '...cataloguing stuff...', '...stuff-sorting...',
    '...checking stuff...', '...stuff-calibrating...', '...aligning the stuff...',
    '...consulting the stuff oracle...', '...polishing stuff...', '...stuff inbound...',
    '...stuff outbound...', '...debugging stuff...', '...stuff in progress...',
    '...warming up the stuff...', '...cooling down the stuff...', '...nudging the stuff...',
  ];
  // One playful message per turn — picked when receiving starts, then held
  // steady so the indicator stays calm instead of cycling every few seconds.
  const [stuffIndex, setStuffIndex] = useState(0);
  useEffect(() => {
    if (chatState.status !== 'receiving') return;
    setStuffIndex(Math.floor(Math.random() * stuffMessages.length));
  }, [chatState.status]);

  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    const startedAt = chatState.receivingStartedAt;
    if (chatState.status !== 'receiving' || !startedAt) {
      setElapsedMs(0);
      return;
    }
    setElapsedMs(Date.now() - startedAt);
    const interval = setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 1000);
    return () => clearInterval(interval);
  }, [chatState.status, chatState.receivingStartedAt]);

  // Shift+Tab to accept first pending permission card (allow_once)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && e.shiftKey) {
        const pending = chatState.messages.find(m => m.permission && !m.permission.resolved);
        if (!pending?.permission) return;
        const allowOption = pending.permission.options.find(o => o.kind === 'allow_once')
          ?? pending.permission.options[0];
        if (!allowOption) return;
        e.preventDefault();
        vscode.postMessage({
          type: 'permissionResponse',
          messageId: pending.permission.messageId,
          optionId: allowOption.optionId,
        } as WebviewMessage);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [chatState.messages]);

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div className="top-bar-row top-bar-row--status">
          <div className="status-cluster">
            <span className={`status-dot status-${connectionStatus}`} title={statusLabel} />
            <span
              className="status-label"
              title={[
                statusLabel,
                chatState.session?.resolvedModel,
                chatState.gcloud.account,
              ].filter(Boolean).join('\n')}
            >
              {statusLabel}
            </span>
            {chatState.gcloud.errorMessage && !chatState.session?.resolvedModel && chatState.connection !== 'connected' && (
              <button
                className="gcloud-error-badge"
                type="button"
                onClick={handleRefreshGcloud}
                title={chatState.gcloud.errorMessage}
              >
                Not signed in
              </button>
            )}
          </div>
          <div className="top-bar-primary-actions">
            <button
              className="icon-button"
              type="button"
              onClick={handleShowHistory}
              title="Chat history"
              aria-label="Chat history"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M8 1.5a6.5 6.5 0 1 0 4.6 11.1l-.71-.71A5.5 5.5 0 1 1 13.5 8H12l2 2 2-2h-1.5A6.5 6.5 0 0 0 8 1.5zm-.5 3v4.2l3.05 1.76.5-.86L8.5 8.15V4.5h-1z"/>
              </svg>
            </button>
            <button
              className="icon-button icon-button-primary"
              type="button"
              onClick={handleNewConversation}
              title="New conversation (Ctrl+L)"
              aria-label="New conversation"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M14.5 1h-13C.67 1 0 1.67 0 2.5v10c0 .83.67 1.5 1.5 1.5H5v2l3-2h6.5c.83 0 1.5-.67 1.5-1.5v-10c0-.83-.67-1.5-1.5-1.5zM8.75 9h-1.5V7.75H6v-1.5h1.25V5h1.5v1.25H10v1.5H8.75V9z"/>
              </svg>
            </button>
            <div className="overflow-menu-wrap" ref={menuRef}>
              <button
                className="icon-button"
                type="button"
                onClick={() => setShowMenu(value => !value)}
                title="Tools and settings"
                aria-label="Tools and settings"
                aria-haspopup="menu"
                aria-expanded={showMenu}
              >
                <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M4 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm5.5 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm5.5 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/>
                </svg>
              </button>
              {showMenu && (
                <div className="overflow-menu" role="menu" aria-label="Tools and settings">
                  <button type="button" className="menu-item" role="menuitem" onClick={() => { setShowMenu(false); handleOpenCheckpoints(); }}>
                    Checkpoints
                  </button>
                  <button type="button" className="menu-item" role="menuitem" onClick={() => { setShowMenu(false); handleOpenMemory(); }}>
                    Memory Studio
                  </button>
                  <button type="button" className="menu-item" role="menuitem" onClick={() => { setShowMenu(false); handleOpenContextDashboard(); }}>
                    Context Dashboard
                  </button>
                  <button type="button" className="menu-item" role="menuitem" onClick={() => { setShowMenu(false); handleOpenMcpInspector(); }}>
                    MCP Tool Inspector
                  </button>
                  <button type="button" className="menu-item" role="menuitem" onClick={() => { setShowMenu(false); handleOpenExtensions(); }}>
                    Extension Manager
                  </button>
                  <button
                    type="button"
                    className="menu-item"
                    role="menuitem"
                    disabled={chatState.messages.length === 0}
                    onClick={() => { setShowMenu(false); vscode.postMessage({ type: 'exportConversation' }); }}
                  >
                    Export Conversation
                  </button>
                  <div className="menu-divider" role="separator" />
                  <button type="button" className="menu-item" role="menuitem" onClick={() => { setShowMenu(false); handleRunDiagnostics(); }}>
                    Run Diagnostics
                  </button>
                  <button type="button" className="menu-item" role="menuitem" onClick={() => { setShowMenu(false); handleOpenSettings(); }}>
                    Gemini CLI Settings
                  </button>
                  <button type="button" className="menu-item" role="menuitem" onClick={() => { setShowMenu(false); setShowHelp(true); }}>
                    Help &amp; Shortcuts
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <section
        ref={transcriptRef}
        className="transcript"
        aria-live="polite"
        onScroll={event => {
          const target = event.currentTarget;
          transcriptNearBottomRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 100;
          setVirtualScroll({ top: target.scrollTop, height: target.clientHeight });
        }}
      >
        {showDiagnostics && chatState.diagnostics && (
          <DiagnosticsPanel
            report={chatState.diagnostics}
            problems={diagnosticProblems}
            onAction={handleDiagnosticAction}
            onClose={() => setShowDiagnostics(false)}
          />
        )}
        {showMcpInspector && chatState.mcp && (
          <McpInspectorPanel
            report={chatState.mcp}
            problemCount={mcpProblemCount}
            onAction={handleMcpAction}
          />
        )}
        {showExtensions && (
          <ExtensionManagerPanel
            report={chatState.extensions}
            installUrl={extensionUrl}
            onInstallUrlChange={setExtensionUrl}
            onAction={handleExtensionAction}
          />
        )}
        {showMemory && (
          <MemoryStudioPanel
            memory={chatState.memory}
            draft={memoryDraft}
            disabled={memoryDisabled}
            lastAssistantText={lastAssistantMessage?.content ?? ''}
            onDraftChange={setMemoryDraft}
            onRefresh={() => vscode.postMessage({ type: 'refreshMemory' })}
            onPrepareAdd={() => {
              vscode.postMessage({ type: 'prepareMemoryAdd', text: memoryDraft });
            }}
            onConfirmAdd={() => {
              vscode.postMessage({ type: 'confirmMemoryAdd' });
              setMemoryDraft('');
            }}
            onCancelAdd={() => vscode.postMessage({ type: 'cancelMemoryAdd' })}
            onRunInit={() => vscode.postMessage({ type: 'runMemoryInit' })}
            onAcceptInit={(proposalId) => vscode.postMessage({ type: 'acceptMemoryInit', proposalId })}
            onRejectInit={(proposalId) => vscode.postMessage({ type: 'rejectMemoryInit', proposalId })}
            onOpenFile={(path) => vscode.postMessage({ type: 'openMemoryFile', path })}
            onRunDiagnostics={handleRunDiagnostics}
            onPromoteLast={() => setMemoryDraft(lastAssistantMessage?.content ?? '')}
          />
        )}
        {showCheckpoints && (
          <CheckpointBrowserPanel
            checkpoints={chatState.checkpoints}
            tag={checkpointTag}
            disabled={checkpointsDisabled}
            onTagChange={setCheckpointTag}
            onRefresh={() => vscode.postMessage({ type: 'refreshCheckpoints' })}
            onSave={() => {
              vscode.postMessage({ type: 'saveCheckpoint', tag: checkpointTag });
              setCheckpointTag('');
            }}
            onResumeManual={(tag) => vscode.postMessage({ type: 'resumeManualCheckpoint', tag })}
            onRestoreGemini={(checkpointId) => vscode.postMessage({ type: 'restoreGeminiCheckpoint', checkpointId })}
            onRestoreNative={(sessionId) => vscode.postMessage({ type: 'restoreNativeSession', sessionId })}
            onRollbackTurn={(turnId) => vscode.postMessage({ type: 'rollbackTurn', turnId })}
          />
        )}
        {showContextDashboard && (
          <ContextDashboardPanel
            chatState={chatState}
            usage={contextUsage}
            sources={contextSources}
            onCompress={handleCompressContext}
          />
        )}
        {chatState.messages.length === 0 ? (
          <div className="welcome-state">
            {logoUri && <img className="welcome-logo" src={logoUri} alt="" />}
            <div className="welcome-heading">CalmUI for Gemini CLI</div>
            <p className="welcome-byline">
              by Sam Shennan (<a href="https://www.velesproductions.com">velesproductions.com</a>)
            </p>
            <p className="welcome-subtitle">Ask Gemini anything about your workspace.</p>
            <div className="prompt-chips">
              {[
                'Explain this codebase',
                'Find bugs in the current file',
                'Write tests for the selected code',
                'Refactor this to be simpler',
              ].map((prompt) => (
                <button
                  key={prompt}
                  className="prompt-chip"
                  type="button"
                  onClick={() => setDraft(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
            {!showDiagnostics && (
              <button type="button" className="welcome-check-link" onClick={handleRunDiagnostics}>
                First time here? Check your setup
              </button>
            )}
          </div>
        ) : (
          <>
            {virtualWindow.enabled && (
              <div className="virtual-spacer" style={{ height: virtualWindow.topPadding }} />
            )}
            {renderedMessages.map(message => {
              if (message.permission) {
                return (
                  <article key={message.id} className={`message message-permission${message.permission.resolved ? ' permission-resolved' : ''}`}>
                    <div className="message-author">Permission Request</div>
                    <div className="permission-card">
                      <div className="permission-tool-name">{message.permission.toolName}</div>
                      {message.permission.args && (
                        <pre className="permission-args">{message.permission.args}</pre>
                      )}
                      {message.permission.resolved ? (
                        <div className="permission-resolved-label">
                          Responded: {formatPermissionOptionLabel(message.permission.options.find(o => o.optionId === message.permission!.resolved) ?? message.permission.resolved)}
                        </div>
                      ) : (
                        <div className="permission-buttons">
                          {message.permission.options.map(opt => (
                            <button
                              key={opt.optionId}
                              type="button"
                              className={`permission-btn${opt.kind === 'allow_once' ? ' permission-btn-allow' : opt.kind === 'reject_once' ? ' permission-btn-reject' : ''}`}
                              onClick={() => vscode.postMessage({
                                type: 'permissionResponse',
                                messageId: message.permission!.messageId,
                                optionId: opt.optionId,
                              } as WebviewMessage)}
                            >
                              {formatPermissionOptionLabel(opt)}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </article>
                );
              }

              const isLastAssistant = message.id === lastAssistantId;
              const canEdit = message.role === 'user' && !message.pending && chatState.status !== 'receiving';
              // Phase 39 W3: parse assistant `Sources:` footer once the turn
              // has finished streaming, then render the body (footer-stripped)
              // through Markdown. While `pending` we render the raw streamed
              // text so the user sees the response grow live.
              const parsed: ParsedSources | null =
                message.role === 'assistant' && !message.pending
                  ? (message.parsedSources ?? parseSources(message.content))
                  : null;
              const renderedBody =
                message.role === 'user'
                  ? stripSearchPrefix(message.content)
                  : (parsed?.body ?? message.content);
              const isGrounded = message.role === 'assistant' && message.searchModeAtSend === 'grounded';

              return (
                <article
                  key={message.id}
                  className={`message message-${message.role}${message.pending ? ' message-pending' : ''}`}
                >
                  <div className="message-author">
                    {message.role === 'user' ? (message.pending ? 'You (queued)' : 'You')
                      : message.role === 'error' ? 'Error'
                      : message.role === 'warning' ? 'Gemini CLI warning'
                      : 'Gemini'}
                    {isGrounded && (
                      <span
                        className="search-mode-badge"
                        title="Sent in Search mode — model was invited to use google_web_search"
                        aria-label="Search-grounded turn"
                      >
                        <svg viewBox="0 0 16 16" fill="currentColor" width="11" height="11" aria-hidden="true">
                          <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm5.4 6h-2.1a10.9 10.9 0 0 0-1.1-4.3A6 6 0 0 1 13.4 7zM8 2.1c.7.7 1.4 2.3 1.6 4.9H6.4C6.6 4.4 7.3 2.8 8 2.1zM2.6 7a6 6 0 0 1 3.2-4.3A10.9 10.9 0 0 0 4.7 7H2.6zm0 2h2.1c.1 1.6.5 3.1 1.1 4.3A6 6 0 0 1 2.6 9zm5.4 4.9c-.7-.7-1.4-2.3-1.6-4.9h3.2C9.4 11.6 8.7 13.2 8 13.9zm1.6-.6c.6-1.2 1-2.7 1.1-4.3h2.1a6 6 0 0 1-3.2 4.3z"/>
                        </svg>
                      </span>
                    )}
                    {message.pending && (
                      <button
                        type="button"
                        className="pending-cancel"
                        title="Cancel this queued message"
                        aria-label="Cancel queued message"
                        onClick={() => vscode.postMessage({ type: 'cancelPending', id: message.id })}
                      >
                        ×
                      </button>
                    )}
                    {canEdit && (
                      <button
                        type="button"
                        className="message-action-btn"
                        title="Edit and resend this message"
                        aria-label="Edit message"
                        onClick={() => {
                          setDraft(stripSearchPrefix(message.content));
                          setEditingMessageId(message.id);
                          requestAnimationFrame(() => textareaRef.current?.focus());
                        }}
                      >
                        Edit
                      </button>
                    )}
                    {message.role === 'assistant' && !message.pending && (
                      <button
                        type="button"
                        className="message-action-btn"
                        title="Promote this response to Memory Studio"
                        aria-label="Promote to memory"
                        onClick={() => {
                          setShowMemory(true);
                          setMemoryDraft(message.content);
                          vscode.postMessage({ type: 'openMemoryStudio' });
                        }}
                      >
                        Memory
                      </button>
                    )}
                  </div>
                  {message.thinking && (
                    <details className="thinking-section">
                      <summary className="thinking-summary">Thinking</summary>
                      <div className="thinking-content">{message.thinking}</div>
                    </details>
                  )}
                  <div className="message-content">
                    {message.role === 'assistant' || message.role === 'warning'
                      ? <MarkdownContent content={renderedBody} />
                      : renderedBody}
                  </div>
                  {parsed && (parsed.sources || parsed.raw) && (
                    <SourcesSection
                      sources={parsed.sources}
                      raw={parsed.raw}
                      onOpen={(url) => vscode.postMessage({ type: 'openExternal', url })}
                    />
                  )}
                  {message.changeSummary && (
                    <ChangeTimeline summary={message.changeSummary} />
                  )}
                  {isLastAssistant && (
                    <button
                      type="button"
                      className="btn-secondary retry-button"
                      onClick={() => vscode.postMessage({ type: 'regenerateResponse', messageId: message.id })}
                      title="Re-send the preceding prompt to get a different response"
                    >
                      Retry
                    </button>
                  )}
                </article>
              );
            })}
            {virtualWindow.enabled && (
              <div className="virtual-spacer" style={{ height: virtualWindow.bottomPadding }} />
            )}
          </>
        )}
        {chatState.status === 'receiving' && (
          <div className={`thinking-indicator${chatState.stalled ? ' thinking-stalled' : ''}`}>
            <div className="thinking-row">
              <div className="thinking-logo">
                {logoUri
                  ? <img src={logoUri} alt="" />
                  : (
                    <svg viewBox="0 0 65 65" fill="currentColor">
                      <path d="M32.447 0c.68 0 1.273.465 1.439 1.125a38.904 38.904 0 001.999 5.905c2.152 5 5.105 9.376 8.854 13.125 3.751 3.75 8.126 6.703 13.125 8.855a38.98 38.98 0 005.906 1.999c.66.166 1.124.758 1.124 1.438 0 .68-.464 1.273-1.125 1.439a38.902 38.902 0 00-5.905 1.999c-5 2.152-9.375 5.105-13.125 8.854-3.749 3.751-6.702 8.126-8.854 13.125a38.973 38.973 0 00-2 5.906 1.485 1.485 0 01-1.438 1.124c-.68 0-1.272-.464-1.438-1.125a38.913 38.913 0 00-2-5.905c-2.151-5-5.103-9.375-8.854-13.125-3.75-3.749-8.125-6.702-13.125-8.854a38.973 38.973 0 00-5.905-2A1.485 1.485 0 010 32.448c0-.68.465-1.272 1.125-1.438a38.903 38.903 0 005.905-2c5-2.151 9.376-5.104 13.125-8.854 3.75-3.749 6.703-8.125 8.855-13.125a38.972 38.972 0 001.999-5.905A1.485 1.485 0 0132.447 0z" />
                    </svg>
                  )}
              </div>
              <span className="thinking-text" key={stuffIndex}>{stuffMessages[stuffIndex]}</span>
              {chatState.receivingStartedAt && (
                <span
                  className="thinking-elapsed"
                  title="Time since this turn started"
                  aria-label={`Elapsed: ${formatElapsed(elapsedMs)}`}
                >
                  {formatElapsed(elapsedMs)}
                </span>
              )}
            </div>
            {chatState.stalled && (
              <div className="thinking-stall-hint">
                ⚠ No activity from Gemini for 45s+ — the turn may be stalled. Check Output Channel "CalmUI" for stderr, or press Stop to abort.
              </div>
            )}
          </div>
        )}
      </section>

      <form className={`composer${dragActive ? ' composer-drag-active' : ''}`} onSubmit={handleSubmit}>
        {editingMessageId && (
          <div className="composer-notice composer-notice-info">
            <span>Editing message — send to replace everything from this point</span>
            <button
              type="button"
              className="composer-notice-dismiss"
              onClick={() => { setEditingMessageId(null); setDraft(''); }}
              aria-label="Cancel edit"
            >
              x
            </button>
          </div>
        )}
        {composerNotice && !editingMessageId && (
          <ComposerNotice notice={composerNotice} onDismiss={() => { setImageInputMessage(null); setDismissedNotice(true); }} />
        )}
        {attachments.length > 0 && (
          <AttachmentChipRow attachments={attachments} onRemove={removeAttachment} />
        )}
        {showSketch && (
          <div className="sketch-panel" aria-label="Sketch canvas">
            <SketchCanvas
              onComplete={(chip) => {
                setAttachments(prev => [...prev, { ...chip, id: freshAttachmentId() }]);
                setShowSketch(false);
              }}
              onCancel={() => setShowSketch(false)}
            />
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onPaste={event => {
            const files = Array.from(event.clipboardData.files);
            if (files.length === 0) return;
            if (event.clipboardData.getData('text/plain')) {
              handleDroppedFiles(files);
              return;
            }
            event.preventDefault();
            handleDroppedFiles(files);
          }}
          onDragOver={event => {
            if (Array.from(event.dataTransfer.items).some(item => item.kind === 'file')) {
              event.preventDefault();
              setDragActive(true);
            }
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={event => {
            const files = Array.from(event.dataTransfer.files);
            if (files.length === 0) return;
            event.preventDefault();
            setDragActive(false);
            handleDroppedFiles(event.dataTransfer.files);
          }}
          onKeyDown={event => {
            if (showSlashPopover) {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setSlashIndex(index => (index + 1) % slashMatches.length);
                return;
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setSlashIndex(index => (index - 1 + slashMatches.length) % slashMatches.length);
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                acceptSlashCommand(slashMatches[slashIndex] ?? slashMatches[0]);
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setDraft('');
                return;
              }
            }
            // Up arrow in empty composer = recall last sent prompt
            if (event.key === 'ArrowUp' && !draft.trim() && lastSentPrompt) {
              event.preventDefault();
              setDraft(lastSentPrompt.text);
              setAttachments(lastSentPrompt.attachments);
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              sendPrompt();
            }
          }}
          placeholder={connectionBlocksSend ? 'Gemini ACP is disconnected...' : chatState.status === 'receiving' ? 'Queue another message...' : 'Ask Gemini...'}
          disabled={connectionBlocksSend}
          title={sendDisabledReason}
        />
        {showSlashPopover && (
          <div className="slash-popover" role="listbox" aria-label="Slash commands">
            {slashMatches.map((command, index) => (
              <button
                key={`${command.name}-${index}`}
                type="button"
                className={`slash-option${index === slashIndex ? ' slash-option-active' : ''}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  acceptSlashCommand(command);
                }}
              >
                <span className="slash-name">{command.name}</span>
                {command.description && <span className="slash-description">{command.description}</span>}
                {command.kind && <span className="slash-kind">{command.kind}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="composer-controls">
          <div className="controls-left">
            <button
              type="button"
              className="context-chip"
              onClick={handleIncludeCurrentFile}
              title={chatState.context?.activeFile
                ? `Insert @${chatState.context.activeFile}`
                : 'Insert @-reference for the active file'}
            >
              @ File
            </button>
            <button
              type="button"
              className={`icon-button advanced-toggle${advancedControls ? ' advanced-toggle-on' : ''}`}
              onClick={toggleAdvancedControls}
              title={advancedControls ? 'Hide advanced controls' : 'Show advanced controls (model, search, sketch)'}
              aria-label={advancedControls ? 'Hide advanced controls' : 'Show advanced controls'}
              aria-pressed={advancedControls}
            >
              <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M2 4h7.05a2.5 2.5 0 0 1 4.9 0H14v1.5h-.05a2.5 2.5 0 0 1-4.9 0H2V4zm9.5 1.75a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM2 10.5h.05a2.5 2.5 0 0 1 4.9 0H14V12H6.95a2.5 2.5 0 0 1-4.9 0H2v-1.5zm2.5 1.75a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/>
              </svg>
            </button>
          </div>
          <div className="controls-right">
            <ContextMeter
              usage={chatState.usage}
              info={contextUsage}
              onClick={handleOpenContextDashboard}
            />
            <select
              className="compact-select"
              value={chatState.permissionMode}
              onChange={(e) => handlePermissionModeChange(e.target.value as PermissionMode)}
              aria-label="Permission mode"
            >
              <option value="ask">Ask first</option>
              <option value="yolo">Auto-approve</option>
            </select>
            {chatState.status === 'receiving' ? (
              <>
                {(chatState.queueLength ?? 0) > 0 && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={handleClearQueue}
                    title="Clear all queued messages without stopping the current turn"
                  >
                    Clear queue ({chatState.queueLength})
                  </button>
                )}
                <button type="button" onClick={handleStop}>Stop</button>
              </>
            ) : (
              <button
                type="submit"
                disabled={
                  (!draft.trim() && attachments.length === 0)
                  || connectionBlocksSend
                  || hasUnsupportedAttachment
                }
                title={hasUnsupportedAttachment ? unsupportedDisabledReason : sendDisabledReason}
              >
                Send
              </button>
            )}
          </div>
        </div>
        {advancedControls && (
          <div className="composer-controls composer-controls-advanced">
            <div className="controls-left">
              <select
                className="compact-select"
                value={chatState.model}
                onChange={handleModelChange}
                aria-label="Model"
              >
                {modelOptions.map(option => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
              <SearchModePill
                mode={chatState.searchMode}
                available={chatState.searchAvailable !== false}
                unavailableReason={chatState.searchUnavailableReason ?? null}
                disabled={chatState.status === 'receiving'}
                onSelect={(mode) => vscode.postMessage({ type: 'setSearchMode', mode })}
                onDiagnostics={handleRunDiagnostics}
              />
              <button
                type="button"
                className="context-chip"
                onClick={() => setShowSketch(true)}
                title="Open inline sketch canvas — exports PNG as an image attachment"
                disabled={!chatState.context?.mcpEnabled || chatState.status === 'receiving'}
              >
                Add sketch
              </button>
              {chatState.context?.mcpEnabled && (
                <span
                  className="context-mcp-badge"
                  title="ACP mode is active. File references, images, and persistent sessions are available."
                >
                  ACP session
                </span>
              )}
            </div>
          </div>
        )}
      </form>

      {showHelp && <HelpModal commands={commands} onClose={() => setShowHelp(false)} />}
    </main>
  );
}

function ContextMeter({
  usage,
  info,
  onClick,
}: {
  usage: ChatState['usage'];
  info: ContextUsageInfo | null;
  onClick: () => void;
}) {
  const radius = 5.5;
  const circumference = 2 * Math.PI * radius;
  const percent = info ? Math.min(100, Math.max(0, info.percentage)) : 0;
  const title = usage
    ? buildUsageTooltip(usage, info)
    : 'Context usage appears here once Gemini reports token usage.\nClick to open the Context Dashboard.';
  const label = info
    ? `${info.percentage}%`
    : usage
      ? formatTokens(usage.totalTokens)
      : null;
  return (
    <button
      type="button"
      className={`context-meter context-meter-${info?.level ?? 'idle'}`}
      onClick={onClick}
      title={title}
      aria-label={info ? `Context window ${info.percentage}% full` : 'Context usage'}
    >
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
        <circle cx="7" cy="7" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
        {percent > 0 && (
          <circle
            cx="7"
            cy="7"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={`${(percent / 100) * circumference} ${circumference}`}
            transform="rotate(-90 7 7)"
          />
        )}
      </svg>
      {label && <span className="context-meter-label">{label}</span>}
    </button>
  );
}

function SearchModePill({
  mode,
  available,
  unavailableReason,
  disabled,
  onSelect,
  onDiagnostics,
}: {
  mode: SearchMode;
  available: boolean;
  unavailableReason: string | null;
  disabled: boolean;
  onSelect: (mode: SearchMode) => void;
  onDiagnostics: () => void;
}) {
  const searchTitle = !available
    ? (unavailableReason || 'Search grounding not available — click for diagnostics')
    : 'Send this turn with Google Search grounding';
  const localTitle = 'Send this turn from local context only (codebase + training)';
  return (
    <span className="search-mode-pill" role="group" aria-label="Search mode">
      <button
        type="button"
        className={`search-mode-segment${mode === 'local' ? ' search-mode-segment-active' : ''}`}
        onClick={() => !disabled && onSelect('local')}
        disabled={disabled}
        title={localTitle}
        aria-pressed={mode === 'local'}
        aria-label="Local mode"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" width="11" height="11" aria-hidden="true">
          <path d="M8 1a3 3 0 0 0-3 3v3H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-1V4a3 3 0 0 0-3-3zm-2 6V4a2 2 0 1 1 4 0v3H6z"/>
        </svg>
        <span>Local</span>
      </button>
      <button
        type="button"
        className={`search-mode-segment${mode === 'grounded' ? ' search-mode-segment-active' : ''}${available ? '' : ' search-mode-segment-unavailable'}`}
        onClick={() => {
          if (disabled) return;
          if (!available) { onDiagnostics(); return; }
          onSelect('grounded');
        }}
        disabled={disabled && available}
        title={searchTitle}
        aria-pressed={mode === 'grounded'}
        aria-label="Search mode"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" width="11" height="11" aria-hidden="true">
          <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm5.4 6h-2.1a10.9 10.9 0 0 0-1.1-4.3A6 6 0 0 1 13.4 7zM8 2.1c.7.7 1.4 2.3 1.6 4.9H6.4C6.6 4.4 7.3 2.8 8 2.1zM2.6 7a6 6 0 0 1 3.2-4.3A10.9 10.9 0 0 0 4.7 7H2.6zm0 2h2.1c.1 1.6.5 3.1 1.1 4.3A6 6 0 0 1 2.6 9zm5.4 4.9c-.7-.7-1.4-2.3-1.6-4.9h3.2C9.4 11.6 8.7 13.2 8 13.9zm1.6-.6c.6-1.2 1-2.7 1.1-4.3h2.1a6 6 0 0 1-3.2 4.3z"/>
        </svg>
        <span>Search</span>
      </button>
    </span>
  );
}

function AttachmentChipRow({
  attachments,
  onRemove,
}: {
  attachments: AttachmentChip[];
  onRemove: (id: string) => void;
}) {
  return (
    <div className="attachment-preview-row" aria-label="Attachments">
      {attachments.map((chip) => {
        const removeBtn = (
          <button
            type="button"
            className="attachment-remove"
            onClick={() => onRemove(chip.id)}
            aria-label={`Remove ${chip.kind === 'unsupported' || chip.kind === 'fileRef' || chip.kind === 'pdf' || chip.kind === 'image' ? chip.name : 'attachment'}`}
          >
            x
          </button>
        );
        switch (chip.kind) {
          case 'image':
            return (
              <div key={chip.id} className="image-preview-card">
                <img src={`data:${chip.mimeType};base64,${chip.data}`} alt={chip.name} />
                <span title={chip.name}>{chip.name}</span>
                <button
                  type="button"
                  className="image-remove"
                  onClick={() => onRemove(chip.id)}
                  aria-label={`Remove ${chip.name}`}
                >
                  x
                </button>
              </div>
            );
          case 'fileRef':
            return (
              <div key={chip.id} className="file-ref-chip" title={chip.name}>
                <span className="file-ref-icon" aria-hidden="true">@</span>
                <span className="file-ref-name">@{chip.name}</span>
                {removeBtn}
              </div>
            );
          case 'pdf':
            return (
              <div key={chip.id} className="file-ref-chip pdf-chip" title={chip.name}>
                <span className="file-ref-icon" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
                    <path d="M4 1.5A1.5 1.5 0 0 1 5.5 0h5l4 4v10.5A1.5 1.5 0 0 1 13 16H5.5A1.5 1.5 0 0 1 4 14.5v-13zM10.5 1.5V4H13L10.5 1.5zM5 6h6v1H5V6zm0 2h6v1H5V8zm0 2h4v1H5v-1z"/>
                  </svg>
                </span>
                <span className="file-ref-name">{chip.name}</span>
                <span className="pdf-tag">PDF</span>
                {removeBtn}
              </div>
            );
          case 'unsupported':
            return (
              <div key={chip.id} className="file-ref-chip unsupported-chip" title={chip.reason}>
                <span className="file-ref-icon unsupported-icon" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
                    <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zM7 4h2v5H7V4zm0 6h2v2H7v-2z"/>
                  </svg>
                </span>
                <span className="file-ref-name">{chip.name}</span>
                <span className="unsupported-text">Cannot be sent to Gemini</span>
                {removeBtn}
              </div>
            );
        }
      })}
    </div>
  );
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function readImageAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const data = result.includes(',') ? result.slice(result.indexOf(',') + 1) : result;
      resolve({
        id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: file.name || 'pasted-image',
        mimeType: file.type || 'image/png',
        data,
      });
    };
    reader.readAsDataURL(file);
  });
}

function DiagnosticsPanel({
  report,
  problems,
  onAction,
  onClose,
}: {
  report: DiagnosticsReport;
  problems: DiagnosticsReport['checks'];
  onAction: (action: DiagnosticsAction) => void;
  onClose: () => void;
}) {
  const hasProblems = problems.length > 0;
  const rows = hasProblems ? problems : report.checks.slice(0, 4);
  const generatedAt = new Date(report.generatedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <section className={`diagnostics-panel ${hasProblems ? 'diagnostics-panel-attention' : 'diagnostics-panel-ok'}`}>
      <div className="diagnostics-header">
        <div>
          <div className="diagnostics-title">{hasProblems ? 'Setup needs attention' : 'Setup looks ready'}</div>
          <div className="diagnostics-summary">{report.passed}/{report.total} checks passed at {generatedAt}</div>
        </div>
        <div className="diagnostics-actions">
          <button type="button" className="btn-secondary" onClick={() => onAction('runDiagnostics')}>Retry</button>
          <button type="button" className="btn-secondary" onClick={() => onAction('openVSCodeSettings')}>Settings</button>
          <button type="button" className="btn-secondary" onClick={onClose} aria-label="Close diagnostics">Close</button>
        </div>
      </div>
      <div className="diagnostics-rows">
        {rows.map(check => (
          <div key={check.id} className={`diagnostics-row diagnostics-${check.status}`}>
            <span className="diagnostics-status" aria-hidden="true">
              {check.status === 'pass' ? '✓' : check.status === 'warn' ? '!' : '×'}
            </span>
            <div className="diagnostics-copy">
              <div className="diagnostics-label">{check.label}</div>
              <div className="diagnostics-detail">{check.fix ?? check.detail}</div>
            </div>
            {check.action && check.status !== 'pass' && (
              <button
                type="button"
                className="diagnostics-fix"
                onClick={() => onAction(check.action!)}
              >
                {getDiagnosticsActionLabel(check.action)}
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function McpInspectorPanel({
  report,
  problemCount,
  onAction,
}: {
  report: McpInspectorReport;
  problemCount: number;
  onAction: (action: McpServerAction) => void;
}) {
  const generatedAt = new Date(report.generatedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <section className={`mcp-panel ${problemCount > 0 ? 'mcp-panel-attention' : ''}`}>
      <div className="mcp-header">
        <div>
          <div className="mcp-title">MCP Tool Inspector</div>
          <div className="mcp-summary">
            {report.servers.length} server{report.servers.length === 1 ? '' : 's'} scanned at {generatedAt}
            {problemCount > 0 ? ` • ${problemCount} need attention` : ''}
            {report.restartRequired ? ' • restart session required' : ''}
          </div>
        </div>
        <div className="diagnostics-actions">
          {report.restartRequired && (
            <button type="button" className="btn-secondary" onClick={() => onAction('retryAcp')}>Restart ACP</button>
          )}
          <button type="button" className="btn-secondary" onClick={() => onAction('refreshMcpInspector')}>Rescan</button>
        </div>
      </div>
      {report.restartRequired && (
        <div className="mcp-server-detail">
          MCP configuration changed after this Gemini session started. Rescan updated CalmUI metadata; restart ACP before expecting Gemini to use the new server set.
        </div>
      )}
      <div className="mcp-servers">
        {report.servers.map(server => (
          <details key={server.name} className={`mcp-server mcp-server-${server.status}`} open>
            <summary className="mcp-server-summary">
              <span className={`mcp-status mcp-status-${server.status}`} aria-hidden="true" />
              <span className="mcp-server-name">{server.name}</span>
              <span className="mcp-server-meta">
                {server.transport}
                {server.command ? ` • ${server.command}` : server.url ? ` • ${server.url}` : server.tcp ? ` • ${server.tcp}` : ''}
              </span>
              <span className="mcp-tool-count">{server.toolCount} tool{server.toolCount === 1 ? '' : 's'}</span>
            </summary>
            <div className="mcp-server-body">
              <div className="mcp-server-detail">{server.detail}</div>
              {server.args && server.args.length > 0 && (
                <div className="mcp-server-command">Args: {server.args.join(' ')}</div>
              )}
              {server.action && (
                <button
                  type="button"
                  className="diagnostics-fix"
                  onClick={() => onAction(server.action!)}
                >
                  {getMcpActionLabel(server.action)}
                </button>
              )}
              {server.tools.length > 0 && (
                <div className="mcp-tools">
                  {server.tools.map(tool => (
                    <details key={`${server.name}-${tool.name}`} className="mcp-tool">
                      <summary className="mcp-tool-summary">
                        <span className="mcp-tool-name">{tool.name}</span>
                        {tool.description && <span className="mcp-tool-description">{tool.description}</span>}
                      </summary>
                      {tool.inputSchema ? (
                        <pre className="mcp-tool-schema">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                      ) : null}
                    </details>
                  ))}
                </div>
              )}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

function ExtensionManagerPanel({
  report,
  installUrl,
  onInstallUrlChange,
  onAction,
}: {
  report?: GeminiExtensionReport;
  installUrl: string;
  onInstallUrlChange: (value: string) => void;
  onAction: (action: GeminiExtensionAction, value?: string) => void;
}) {
  const generatedAt = report?.generatedAt
    ? new Date(report.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <section className={`extension-panel ${report?.restartRequired ? 'extension-panel-attention' : ''}`}>
      <div className="extension-header">
        <div>
          <div className="extension-title">Extension Manager</div>
          <div className="extension-summary">
            {getExtensionSummary(report)}{generatedAt ? ` scanned at ${generatedAt}` : ''}
            {report?.restartRequired ? ' - restart session required' : ''}
          </div>
        </div>
        <button type="button" className="btn-secondary" onClick={() => onAction('refreshExtensions')}>Refresh</button>
      </div>

      {report?.restartRequired && (
        <div className="extension-warning">
          Extension changes were launched after this Gemini session started. Start a new Gemini session before relying on changed commands, hooks, context, or MCP servers.
        </div>
      )}

      <div className="extension-install-row">
        <input
          value={installUrl}
          onChange={event => onInstallUrlChange(event.target.value)}
          placeholder="https://github.com/org/gemini-extension.git"
          aria-label="Extension URL"
        />
        <button
          type="button"
          className="btn-secondary"
          disabled={!installUrl.trim()}
          onClick={() => onAction('installExtension', installUrl)}
        >
          Install
        </button>
      </div>

      {report?.warnings.length ? (
        <div className="extension-warning-list">
          {report.warnings.map(warning => <div key={warning}>{warning}</div>)}
        </div>
      ) : null}

      {!report || report.extensions.length === 0 ? (
        <div className="extension-empty">No installed Gemini CLI extensions were found.</div>
      ) : (
        <div className="extension-list">
          {report.extensions.map(extension => (
            <details key={extension.id} className={`extension-card extension-card-${extension.status}`} open>
              <summary className="extension-card-summary">
                <span className={`extension-status extension-status-${extension.status}`} aria-hidden="true" />
                <span className="extension-name">{extension.name}</span>
                <span className="extension-meta">
                  {extension.version ? `v${extension.version} - ` : ''}{extension.sourceKind}{extension.status !== 'unknown' ? ` - ${extension.status}` : ''}
                </span>
              </summary>
              <div className="extension-card-body">
                {extension.description && <div className="extension-detail">{extension.description}</div>}
                <div className="extension-detail" title={extension.path}>{extension.path}</div>
                {extension.source && <div className="extension-detail" title={extension.source}>Source: {extension.source}</div>}
                {extension.contributions.length === 0 ? (
                  <div className="extension-empty">No manifest contributions detected.</div>
                ) : (
                  <div className="extension-contributions">
                    {extension.contributions.map(contribution => (
                      <div className="extension-contribution" key={`${extension.id}-${contribution.kind}`}>
                        <span>{contribution.kind}</span>
                        <span title={contribution.names.join(', ')}>{contribution.names.join(', ')}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="extension-actions">
                  <button type="button" className="diagnostics-fix" onClick={() => onAction('openExtensionManifest', extension.manifestPath)}>Manifest</button>
                  <button type="button" className="diagnostics-fix" onClick={() => onAction('updateExtension', extension.name)}>Update</button>
                  {extension.status !== 'enabled' && (
                    <button type="button" className="diagnostics-fix" onClick={() => onAction('enableExtension', extension.name)}>Enable</button>
                  )}
                  {extension.status !== 'disabled' && (
                    <button type="button" className="diagnostics-fix" onClick={() => onAction('disableExtension', extension.name)}>Disable</button>
                  )}
                </div>
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}

function ContextDashboardPanel({
  chatState,
  usage,
  sources,
  onCompress,
}: {
  chatState: ChatState;
  usage: ContextUsageInfo | null;
  sources: ContextSourceInfo[];
  onCompress: () => void;
}) {
  const activeModel = chatState.session?.resolvedModel ?? (chatState.model === 'auto' ? 'Auto' : chatState.model);
  const usageText = chatState.usage
    ? usage?.label ?? `${formatTokens(chatState.usage.totalTokens)} tokens`
    : 'No usage reported yet';
  const pressure = usage?.level ?? 'normal';
  const canCompress = usage?.level === 'warning' || usage?.level === 'critical';

  return (
    <section className={`context-dashboard context-dashboard-${pressure}`}>
      <div className="context-dashboard-header">
        <div>
          <div className="context-dashboard-title">Context Dashboard</div>
          <div className="context-dashboard-summary">{activeModel} - {usageText}{usage?.estimated ? ' estimated' : ''}</div>
        </div>
        <button type="button" className="btn-secondary" onClick={onCompress} disabled={!canCompress || chatState.status === 'receiving'}>
          /compress
        </button>
      </div>

      <div className="context-pressure-row">
        <span className={`context-pressure-dot context-pressure-${pressure}`} />
        <span>{usage ? `${usage.percentage}% pressure` : 'Usage unavailable'}</span>
        {usage && <span className="context-pressure-detail">limit estimate {formatTokens(usage.limit)}</span>}
      </div>

      {sources.length === 0 ? (
        <div className="context-empty">No active context sources are visible yet.</div>
      ) : (
        <div className="context-source-list">
          {sources.map(source => (
            <div className="context-source-row" key={source.id}>
              <div>
                <div className="context-source-title">{source.label}</div>
                <div className="context-source-detail" title={source.detail}>{source.detail}</div>
              </div>
              <span className={`context-origin context-origin-${originClass(source.origin)}`}>{source.origin}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function originClass(origin: ContextSourceOrigin): string {
  return origin.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function CheckpointBrowserPanel({
  checkpoints,
  tag,
  disabled,
  onTagChange,
  onRefresh,
  onSave,
  onResumeManual,
  onRestoreGemini,
  onRestoreNative,
  onRollbackTurn,
}: {
  checkpoints: CheckpointState | undefined;
  tag: string;
  disabled: boolean;
  onTagChange: (value: string) => void;
  onRefresh: () => void;
  onSave: () => void;
  onResumeManual: (tag: string) => void;
  onRestoreGemini: (checkpointId: string) => void;
  onRestoreNative: (sessionId: string) => void;
  onRollbackTurn: (turnId: number) => void;
}) {
  const generatedAt = checkpoints?.generatedAt
    ? new Date(checkpoints.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;
  const busy = checkpoints?.status === 'loading' || checkpoints?.status === 'saving' || checkpoints?.status === 'restoring';
  const hasAnyRows = Boolean(
    checkpoints
    && (checkpoints.nativeSessions.length
      + checkpoints.manualCheckpoints.length
      + checkpoints.restoreCheckpoints.length
      + checkpoints.turnRestorePoints.length) > 0,
  );

  return (
    <section className={`checkpoint-panel${checkpoints?.status === 'error' ? ' checkpoint-panel-attention' : ''}`}>
      <div className="checkpoint-header">
        <div>
          <div className="checkpoint-title">Checkpoint Browser</div>
          <div className="checkpoint-summary">
            {getCheckpointSummary(checkpoints)}{generatedAt ? ` at ${generatedAt}` : ''}
          </div>
        </div>
        <button type="button" className="btn-secondary" onClick={onRefresh} disabled={disabled || busy}>Refresh</button>
      </div>

      {checkpoints?.dirtyWorktree && (
        <div className="checkpoint-warning">Dirty worktree detected. Restore and resume actions will ask before changing state.</div>
      )}
      {checkpoints?.error && (
        <div className="checkpoint-error">{checkpoints.error}</div>
      )}

      <div className="checkpoint-save">
        <input
          value={tag}
          onChange={event => onTagChange(event.target.value)}
          placeholder="checkpoint-tag"
          disabled={disabled || busy}
        />
        <button type="button" onClick={onSave} disabled={disabled || busy || !tag.trim()}>Save Tag</button>
      </div>

      {!hasAnyRows && (
        <div className="checkpoint-empty">No checkpoints loaded yet. Refresh to scan Gemini history and restore points.</div>
      )}

      {checkpoints && checkpoints.nativeSessions.length > 0 && (
        <CheckpointGroup title="Native Sessions">
          {checkpoints.nativeSessions.map(session => (
            <div className="checkpoint-row" key={session.id}>
              <div>
                <div className="checkpoint-row-title">{session.title || session.id}</div>
                <div className="checkpoint-row-detail">
                  {session.messageCount} message{session.messageCount === 1 ? '' : 's'} - {formatDateTime(session.updatedAt ?? session.createdAt)}
                </div>
              </div>
              <button type="button" className="btn-secondary" onClick={() => onRestoreNative(session.id)} disabled={disabled || busy}>Load</button>
            </div>
          ))}
        </CheckpointGroup>
      )}

      {checkpoints && checkpoints.manualCheckpoints.length > 0 && (
        <CheckpointGroup title="Saved Chat Tags">
          {checkpoints.manualCheckpoints.map(saved => (
            <div className="checkpoint-row" key={saved.tag}>
              <div>
                <div className="checkpoint-row-title">{saved.tag}</div>
                <div className="checkpoint-row-detail">Manual Gemini checkpoint from /chat save</div>
              </div>
              <button type="button" className="btn-secondary" onClick={() => onResumeManual(saved.tag)} disabled={disabled || busy}>Resume</button>
            </div>
          ))}
        </CheckpointGroup>
      )}

      {checkpoints && checkpoints.restoreCheckpoints.length > 0 && (
        <CheckpointGroup title="Gemini Restore Points">
          {checkpoints.restoreCheckpoints.map(point => (
            <div className="checkpoint-row" key={point.id}>
              <div>
                <div className="checkpoint-row-title">{point.id}</div>
                {point.detail && <div className="checkpoint-row-detail">{point.detail}</div>}
              </div>
              <button type="button" className="btn-secondary" onClick={() => onRestoreGemini(point.id)} disabled={disabled || busy}>Restore</button>
            </div>
          ))}
        </CheckpointGroup>
      )}

      {checkpoints && checkpoints.turnRestorePoints.length > 0 && (
        <CheckpointGroup title="CalmUI Turn Rollbacks">
          {checkpoints.turnRestorePoints.map(point => (
            <div className="checkpoint-row" key={point.turnId}>
              <div>
                <div className="checkpoint-row-title">Turn {point.turnId}</div>
                <div className="checkpoint-row-detail">
                  {point.filesChanged} file{point.filesChanged === 1 ? '' : 's'} changed - +{point.additions} / -{point.deletions}
                </div>
              </div>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => onRollbackTurn(point.turnId)}
                disabled={disabled || busy || !point.rollbackAvailable}
              >
                Rollback
              </button>
            </div>
          ))}
        </CheckpointGroup>
      )}
    </section>
  );
}

function CheckpointGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="checkpoint-group" open>
      <summary>{title}</summary>
      <div className="checkpoint-list">{children}</div>
    </details>
  );
}

function MemoryStudioPanel({
  memory,
  draft,
  disabled,
  lastAssistantText,
  onDraftChange,
  onRefresh,
  onPrepareAdd,
  onConfirmAdd,
  onCancelAdd,
  onRunInit,
  onAcceptInit,
  onRejectInit,
  onOpenFile,
  onRunDiagnostics,
  onPromoteLast,
}: {
  memory: ChatState['memory'];
  draft: string;
  disabled: boolean;
  lastAssistantText: string;
  onDraftChange: (value: string) => void;
  onRefresh: () => void;
  onPrepareAdd: () => void;
  onConfirmAdd: () => void;
  onCancelAdd: () => void;
  onRunInit: () => void;
  onAcceptInit: (proposalId: string) => void;
  onRejectInit: (proposalId: string) => void;
  onOpenFile: (path: string) => void;
  onRunDiagnostics: () => void;
  onPromoteLast: () => void;
}) {
  const existingSources = getMemoryExistingSources(memory);
  const pending = memory?.pendingAdd;
  const proposal = memory?.initProposal;
  const generatedAt = memory?.generatedAt
    ? new Date(memory.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;
  const title = existingSources.length > 0 ? 'Memory Studio' : 'Memory Studio - no GEMINI.md yet';

  return (
    <section className={`memory-panel${memory?.status === 'error' ? ' memory-panel-attention' : ''}`}>
      <div className="memory-header">
        <div>
          <div className="memory-title">{title}</div>
          <div className="memory-summary">
            {memory?.status === 'loading' ? 'Loading memory sources...'
              : generatedAt ? `${existingSources.length}/${memory?.sources.length ?? 0} sources loaded at ${generatedAt}`
              : 'Memory sources not loaded yet'}
          </div>
        </div>
        <div className="diagnostics-actions">
          <button type="button" className="btn-secondary" onClick={onRefresh} disabled={disabled || memory?.status === 'loading'}>Refresh</button>
          <button type="button" className="btn-secondary" onClick={onRunInit} disabled={disabled}>Run /init</button>
        </div>
      </div>

      {memory?.error && (
        <div className="memory-error">
          <span>{memory.error}</span>
          <button type="button" className="diagnostics-fix" onClick={onRunDiagnostics}>Run Diagnostics</button>
        </div>
      )}

      {existingSources.length === 0 ? (
        <div className="memory-empty">
          <div>
            <div className="memory-source-title">No active GEMINI.md files found</div>
            <div className="memory-source-detail">Expected project memory at ./GEMINI.md and global memory at ~/.gemini/GEMINI.md.</div>
          </div>
          <button type="button" className="btn-secondary" onClick={onRunInit} disabled={disabled}>Run /init</button>
        </div>
      ) : (
        <div className="memory-sources">
          {existingSources.map(source => (
            <details key={source.path} className="memory-source" open={source.kind === 'project'}>
              <summary className="memory-source-summary">
                <span className="memory-source-title">{getMemorySourceLabel(source.kind)}</span>
                <button
                  type="button"
                  className="memory-path"
                  onClick={(event) => {
                    event.preventDefault();
                    onOpenFile(source.path);
                  }}
                  title={source.path}
                >
                  {source.path}
                </button>
              </summary>
              <pre className="memory-content">{source.content || '(empty)'}</pre>
            </details>
          ))}
        </div>
      )}

      <div className="memory-add">
        <label className="memory-label" htmlFor="memory-add-text">Add Memory</label>
        <textarea
          id="memory-add-text"
          className="memory-textarea"
          value={draft}
          onChange={event => onDraftChange(event.target.value)}
          placeholder="Durable project preference, convention, or context..."
          disabled={disabled || memory?.status === 'saving'}
        />
        <div className="memory-actions">
          <button type="button" className="btn-secondary" onClick={onPromoteLast} disabled={disabled || !lastAssistantText}>Promote Last</button>
          <button type="button" className="btn-secondary" onClick={onPrepareAdd} disabled={disabled || !draft.trim()}>Review Save</button>
        </div>
      </div>

      {pending && (
        <div className="memory-confirm">
          <div className="memory-source-title">Confirm memory append</div>
          <div className="memory-source-detail">Target: {pending.targetPath}</div>
          <pre className="memory-content">{pending.text}</pre>
          <div className="memory-actions">
            <button type="button" onClick={onConfirmAdd} disabled={disabled || memory?.status === 'saving'}>Save</button>
            <button type="button" className="btn-secondary" onClick={onCancelAdd}>Cancel</button>
          </div>
        </div>
      )}

      {proposal && (
        <div className="memory-confirm">
          <div className="memory-source-title">/init proposal ready</div>
          <div className="memory-source-detail">A VS Code diff preview opened for {proposal.targetPath}. Accept runs /init through Gemini CLI; reject discards this proposal.</div>
          <div className="memory-actions">
            <button type="button" onClick={() => onAcceptInit(proposal.id)} disabled={disabled || memory?.status === 'saving'}>Accept</button>
            <button type="button" className="btn-secondary" onClick={() => onRejectInit(proposal.id)}>Reject</button>
          </div>
        </div>
      )}
    </section>
  );
}

function ComposerNotice({ notice, onDismiss }: { notice: NonNullable<ReturnType<typeof buildComposerNotice>>; onDismiss: () => void }) {
  return (
    <div className={`composer-notice composer-notice-${notice.level}`}>
      <span>{notice.text}</span>
      {notice.action && <button type="button" className="composer-notice-action" disabled>{notice.action}</button>}
      <button type="button" className="composer-notice-dismiss" onClick={onDismiss} aria-label="Dismiss notice">x</button>
    </div>
  );
}

function getSlashQuery(draft: string): string | null {
  const trimmedStart = draft.replace(/^\s+/, '');
  if (!trimmedStart.startsWith('/')) return null;
  if (/\s/.test(trimmedStart)) return null;
  return trimmedStart;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

function formatPermissionOptionLabel(option: PermissionOption | string | undefined): string {
  const optionId = typeof option === 'string' ? option : option?.optionId;
  const rawLabel = typeof option === 'string' ? option : option?.label;
  const key = (optionId || rawLabel || '').toLowerCase();
  if (key === 'proceed_once' || key === 'allow_once') return 'Allow once';
  if (key === 'proceed_always' || key === 'allow_always') return 'Always allow';
  if (key === 'cancel' || key === 'reject_once' || key === 'deny') return 'Deny';
  if (key === 'reject_always') return 'Always deny';
  return rawLabel || optionId || 'Choose';
}

function buildUsageTooltip(
  usage: { totalTokens: number; models?: Record<string, number> },
  context?: ContextUsageInfo | null,
): string {
  const lines: string[] = [`Total: ${usage.totalTokens.toLocaleString()} tokens (updated live when ACP reports usage)`];
  if (context) {
    lines.push(`Context: ${context.percentage}% of ${formatTokens(context.limit)} for ${context.modelId}`);
    if (context.level === 'warning') {
      lines.push('Warning: context is above 80%. Consider /compress soon.');
    }
    if (context.level === 'critical') {
      lines.push('Critical: context is above 95%. Run /compress or start a new conversation.');
    }
  } else {
    lines.push('Context limit: unknown for the active model.');
  }
  if (usage.models) {
    for (const [name, count] of Object.entries(usage.models)) {
      lines.push(`  ${name}: ${count.toLocaleString()}`);
    }
  }
  return lines.join('\n');
}

function HelpModal({ commands, onClose }: { commands: SlashCommand[]; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>CalmUI — Help</h2>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close help">×</button>
        </header>
        <div className="modal-body">
          <section>
            <h3>Keyboard</h3>
            <ul>
              <li><kbd>Enter</kbd> — send prompt</li>
              <li><kbd>Shift</kbd>+<kbd>Enter</kbd> — newline</li>
              <li><kbd>Escape</kbd> — cancel generation (while receiving)</li>
              <li><kbd>↑</kbd> — recall last sent prompt (in empty composer)</li>
              <li><kbd>Ctrl</kbd>+<kbd>L</kbd> — new conversation</li>
              <li><kbd>Shift</kbd>+<kbd>Tab</kbd> — accept permission (allow once)</li>
              <li><kbd>Esc</kbd> — close this dialog</li>
            </ul>
          </section>
          <section>
            <h3>Slash commands available in this session</h3>
            <ul>
              {commands.map(command => (
                <li key={command.name}>
                  <code>{command.name}</code>
                  {command.description ? ` — ${command.description}` : ''}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3>Edit & Retry</h3>
            <ul>
              <li>Hover a user message and click <strong>Edit</strong> to revise and resend it (conversation truncates from that point).</li>
              <li>Click <strong>Retry</strong> below the last Gemini response to regenerate it.</li>
            </ul>
          </section>
          <section>
            <h3>@-references</h3>
            <p>Use <code>@path/to/file</code> inside your prompt to include that file's contents.</p>
            <p>ACP is the default transport, so image input, session history, permission prompts, and MCP editor context are available without extra setup.</p>
          </section>
          <section>
            <h3>Settings</h3>
            <ul>
              <li>Open VS Code settings and search <code>CalmUI</code> for all options.</li>
              <li>Use the <strong>&#8943;</strong> menu in the top bar for Checkpoints, Memory, Context, Extensions, Diagnostics, and Gemini CLI settings.</li>
              <li>Use the sliders button next to the composer to reveal advanced controls (model, search mode, sketch).</li>
              <li>The ring next to Send shows how full the context window is — click it for the Context Dashboard.</li>
            </ul>
          </section>
          <section>
            <h3>Common issues</h3>
            <ul>
              <li><strong>"Not signed in"</strong> — click the badge, or run <code>gcloud auth login</code>.</li>
              <li><strong>Wrong Google account (Vertex)</strong> — check CalmUI &gt; Google Cloud Project and your gcloud config.</li>
              <li><strong>Missing gemini binary</strong> — set CalmUI &gt; Gemini Path to the absolute path.</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

function ChangeTimeline({ summary }: { summary: NonNullable<ChatState['messages'][number]['changeSummary']> }) {
  const totalAdditions = summary.files.reduce((sum, file) => sum + file.additions, 0);
  const totalDeletions = summary.files.reduce((sum, file) => sum + file.deletions, 0);
  const fileLabel = `${summary.files.length} file${summary.files.length === 1 ? '' : 's'} changed`;
  return (
    <details className="change-timeline">
      <summary>
        <span>[Turn {summary.turnId}] {fileLabel}</span>
        <span className="change-counts">+{totalAdditions} / -{totalDeletions}</span>
      </summary>
      <div className="change-list">
        {summary.files.map(file => (
          <div key={file.path} className="change-file">
            <span className="change-path">{file.path}</span>
            <span className="change-counts">+{file.additions} / -{file.deletions}</span>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="btn-secondary rollback-button"
        disabled={!summary.rollbackAvailable}
        onClick={() => vscode.postMessage({ type: 'rollbackTurn', turnId: summary.turnId })}
        title={summary.rollbackAvailable ? 'Apply a reverse patch back to the turn-start git snapshot' : 'Rollback already used or unavailable'}
      >
        Rollback this turn
      </button>
    </details>
  );
}

function MarkdownContent({ content }: { content: string }) {
  const blocks = parseMarkdownBlocks(content);
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'heading': {
            const Tag = `h${block.level || 3}` as keyof JSX.IntrinsicElements;
            return <Tag key={index}>{renderInlineMarkdown(block.text)}</Tag>;
          }
          case 'list':
            return (
              <ul key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
                ))}
              </ul>
            );
          case 'code':
            if (block.lang?.toLowerCase() === 'diff') {
              return (
                <div key={index} className="code-block-wrapper diff-block-wrapper">
                  <button
                    className="copy-button diff-stage-button"
                    onClick={() => vscode.postMessage({ type: 'stageDiffBlock', diff: block.text })}
                    aria-label="Stage diff"
                  >
                    Stage these changes
                  </button>
                  <pre className="code-block diff-block"><code>{renderDiffLines(block.text)}</code></pre>
                </div>
              );
            }
            return (
              <div key={index} className="code-block-wrapper">
                <button
                  className="copy-button"
                  onClick={(e) => {
                    vscode.postMessage({ type: 'copyToClipboard', text: block.text });
                    const btn = e.currentTarget;
                    btn.textContent = 'Copied!';
                    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
                  }}
                  aria-label="Copy code"
                >
                  Copy
                </button>
                <pre className="code-block"><code>{block.text}</code></pre>
              </div>
            );
          case 'ordered-list':
            return (
              <ol key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
                ))}
              </ol>
            );
          case 'blockquote':
            return (
              <blockquote key={index}>{renderInlineMarkdown(block.text)}</blockquote>
            );
          case 'table':
            return (
              <div key={index} className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      {block.headers.map((h, hi) => (
                        <th key={hi}>{renderInlineMarkdown(h)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, ri) => (
                      <tr key={ri}>
                        {row.map((cell, ci) => (
                          <td key={ci}>{renderInlineMarkdown(cell)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'hr':
            return <hr key={index} />;
          case 'paragraph':
            return <p key={index}>{renderInlineMarkdown(block.text)}</p>;
        }
      })}
    </>
  );
}

function renderDiffLines(text: string): ReactNode[] {
  return text.split('\n').map((line, index) => {
    const className = line.startsWith('+') && !line.startsWith('+++')
      ? 'diff-line diff-add'
      : line.startsWith('-') && !line.startsWith('---')
        ? 'diff-line diff-del'
        : line.startsWith('@@')
          ? 'diff-line diff-hunk'
          : 'diff-line';
    return <span key={index} className={className}>{line || ' '}{'\n'}</span>;
  });
}

type MarkdownBlock =
  | { type: 'heading'; text: string; level?: number }
  | { type: 'list'; items: string[] }
  | { type: 'ordered-list'; items: string[] }
  | { type: 'code'; text: string; lang?: string }
  | { type: 'blockquote'; text: string }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'hr' }
  | { type: 'paragraph'; text: string };

function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const lines = content.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.startsWith('```')) {
      const lang = line.slice(3).trim() || undefined;
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', text: codeLines.join('\n'), lang });
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', text: heading[2], level: heading[1].length });
      index += 1;
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      index += 1;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'blockquote', text: quoteLines.join('\n') });
      continue;
    }

    // Table (pipe-delimited with separator row)
    if (line.includes('|') && index + 1 < lines.length && /^\s*\|?\s*[-:]+[-|:\s]+\s*\|?\s*$/.test(lines[index + 1])) {
      const parseRow = (row: string) =>
        row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
      const headers = parseRow(line);
      index += 2; // skip header + separator
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(parseRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ''));
        index += 1;
      }
      blocks.push({ type: 'list', items });
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ''));
        index += 1;
      }
      blocks.push({ type: 'ordered-list', items });
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].startsWith('```') &&
      !/^(#{1,3})\s+/.test(lines[index]) &&
      !/^\s*[-*]\s+/.test(lines[index]) &&
      !/^\s*\d+[.)]\s+/.test(lines[index]) &&
      !/^>\s?/.test(lines[index]) &&
      !/^[-*_]{3,}\s*$/.test(lines[index]) &&
      !(lines[index].includes('|') && index + 1 < lines.length && /^\s*\|?\s*[-:]+/.test(lines[index + 1] ?? ''))
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
  }

  return blocks.length ? blocks : [{ type: 'paragraph', text: content }];
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Order matters: backtick code first (no nesting), then bold, italic, strikethrough, links
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    if (token.startsWith('`')) {
      nodes.push(<code key={nodes.length} className="inline-code">{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={nodes.length}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('~~')) {
      nodes.push(<del key={nodes.length}>{token.slice(2, -2)}</del>);
    } else if (token.startsWith('*')) {
      nodes.push(<em key={nodes.length}>{token.slice(1, -1)}</em>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (link) {
        const href = link[2];
        if (/^(https?|mailto|vscode|vscode-insiders):/i.test(href)) {
          nodes.push(
            <a key={nodes.length} href={href} title={href}>
              {link[1]}
            </a>,
          );
        } else {
          nodes.push(<span key={nodes.length}>{link[1]}</span>);
        }
      }
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

const root = createRoot(document.getElementById('root')!);
root.render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);

const style = document.createElement('style');
style.textContent = `
  * {
    box-sizing: border-box;
  }

  html,
  body,
  #root {
    height: 100%;
    margin: 0;
  }

  body {
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }

  .app-shell {
    display: grid;
    grid-template-rows: auto 1fr auto;
    height: 100%;
    min-width: 0;
  }

  .top-bar {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: 0;
    border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border));
  }

  .top-bar-row {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .top-bar-row--status {
    justify-content: space-between;
    gap: 6px 8px;
    padding: 6px 10px 6px 12px;
    border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border, rgba(128,128,128,0.15)));
  }

  .top-bar-primary-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 0 0 auto;
  }

  .status-cluster {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 8px;
    min-width: 0;
    flex: 1 1 auto;
  }

  .status-cluster > * {
    min-width: 0;
  }

  .overflow-menu-wrap {
    position: relative;
  }

  .overflow-menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 60;
    display: grid;
    gap: 1px;
    min-width: min(180px, calc(100vw - 24px));
    max-width: calc(100vw - 16px);
    padding: 4px;
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 6px;
    background: var(--vscode-dropdown-background, var(--vscode-input-background));
    box-shadow: 0 8px 24px var(--vscode-widget-shadow, color-mix(in srgb, var(--vscode-foreground) 22%, transparent));
  }

  .menu-item {
    display: block;
    width: 100%;
    min-width: 0;
    min-height: auto;
    padding: 6px 10px;
    text-align: left;
    font-size: 0.88em;
    color: var(--vscode-foreground);
    background: transparent;
    border: 0;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .menu-item:hover:not(:disabled) {
    background: var(--vscode-list-hoverBackground, var(--vscode-toolbar-hoverBackground));
  }

  .menu-item:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .menu-divider {
    height: 1px;
    margin: 3px 6px;
    background: var(--vscode-panel-border, rgba(128,128,128,0.3));
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--vscode-descriptionForeground);
    flex: 0 0 auto;
  }

  .status-connected {
    background: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
  }

  .status-receiving {
    background: var(--vscode-progressBar-background);
    animation: status-pulse 1.5s ease-in-out infinite;
  }

  .status-disconnected {
    background: var(--vscode-descriptionForeground);
  }

  .status-reconnecting {
    background: var(--vscode-notificationsWarningIcon-foreground, var(--vscode-progressBar-background));
    animation: status-pulse 1.5s ease-in-out infinite;
  }

  @keyframes status-pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }

  .status-error {
    background: var(--vscode-errorForeground);
  }

  .status-label {
    font-weight: 600;
  }

  .icon-button {
    min-width: 26px;
    width: 26px;
    height: 26px;
    padding: 0;
    font-size: 18px;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--vscode-descriptionForeground);
    background: transparent;
    border-color: var(--vscode-panel-border);
  }

  .icon-button:hover:not(:disabled) {
    color: var(--vscode-foreground);
    background: var(--vscode-toolbar-hoverBackground, color-mix(in srgb, var(--vscode-foreground) 10%, transparent));
  }

  .icon-button-primary {
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border-color: var(--vscode-button-border, transparent);
  }

  .icon-button-primary:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground);
    color: var(--vscode-button-foreground);
  }

  .icon-button svg {
    width: 14px;
    height: 14px;
  }

  .gcloud-error-badge {
    min-width: auto;
    min-height: auto;
    padding: 1px 5px;
    font-size: 0.7em;
    color: var(--vscode-descriptionForeground);
    background: transparent;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    margin-left: 4px;
    cursor: pointer;
    opacity: 0.7;
  }

  .gcloud-error-badge:hover {
    opacity: 1;
    color: var(--vscode-foreground);
  }

  .transcript {
    min-height: 0;
    overflow-y: auto;
    padding: 14px 14px 18px;
  }

  .virtual-spacer {
    pointer-events: none;
    flex: 0 0 auto;
  }

  .welcome-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 24px 16px;
    text-align: center;
    gap: 12px;
  }

  .welcome-logo {
    width: 72px;
    height: 72px;
    opacity: 0.95;
    margin-bottom: 4px;
  }

  .welcome-heading {
    font-size: 1.2em;
    font-weight: 600;
    color: var(--vscode-foreground);
  }

  .welcome-byline {
    margin: -6px 0 0;
    font-size: 0.8em;
    color: var(--vscode-descriptionForeground);
  }

  .welcome-byline a {
    color: inherit;
    text-decoration: underline;
  }

  .welcome-subtitle {
    color: var(--vscode-descriptionForeground);
    margin: 0;
    font-size: 0.95em;
  }

  .welcome-check-link {
    min-width: auto;
    min-height: auto;
    margin-top: 12px;
    padding: 2px 4px;
    font-size: 0.82em;
    color: var(--vscode-descriptionForeground);
    background: transparent;
    border: 0;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .welcome-check-link:hover:not(:disabled) {
    color: var(--vscode-textLink-foreground);
    background: transparent;
  }

  .diagnostics-panel {
    display: grid;
    gap: 10px;
    margin-bottom: 12px;
    padding: 10px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    background: color-mix(in srgb, var(--vscode-sideBar-background) 88%, var(--vscode-editor-background));
  }

  .diagnostics-panel-attention {
    border-color: var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border));
    background: var(--vscode-inputValidation-warningBackground, color-mix(in srgb, var(--vscode-editorWarning-foreground, var(--vscode-notificationsWarningIcon-foreground)) 10%, var(--vscode-editor-background)));
  }

  .diagnostics-panel-ok {
    border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, var(--vscode-charts-green)) 45%, var(--vscode-panel-border));
  }

  .diagnostics-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .diagnostics-title {
    font-weight: 600;
  }

  .diagnostics-summary {
    margin-top: 2px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.8em;
  }

  .diagnostics-actions {
    display: flex;
    gap: 6px;
    flex: 0 0 auto;
  }

  .diagnostics-rows {
    display: grid;
    gap: 6px;
  }

  .diagnostics-row {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    min-height: 34px;
    padding: 6px 8px;
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
    border-radius: 4px;
    background: color-mix(in srgb, var(--vscode-input-background) 72%, transparent);
  }

  .diagnostics-status {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    font-size: 0.75em;
    font-weight: 700;
  }

  .diagnostics-pass .diagnostics-status {
    color: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
    border: 1px solid currentColor;
  }

  .diagnostics-warn .diagnostics-status {
    color: var(--vscode-notificationsWarningIcon-foreground, var(--vscode-editorWarning-foreground));
    border: 1px solid currentColor;
  }

  .diagnostics-fail .diagnostics-status {
    color: var(--vscode-errorForeground);
    border: 1px solid currentColor;
  }

  .diagnostics-copy {
    min-width: 0;
  }

  .diagnostics-label {
    font-size: 0.86em;
    font-weight: 600;
  }

  .diagnostics-detail {
    margin-top: 1px;
    overflow: hidden;
    color: var(--vscode-descriptionForeground);
    font-size: 0.78em;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .diagnostics-fix {
    min-width: auto;
    min-height: 24px;
    padding: 2px 8px;
    color: var(--vscode-button-secondaryForeground, var(--vscode-descriptionForeground));
    background: var(--vscode-button-secondaryBackground, transparent);
    border-color: var(--vscode-panel-border);
    font-size: 0.8em;
  }

  .mcp-panel {
    display: grid;
    gap: 10px;
    margin-bottom: 12px;
    padding: 10px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    background: color-mix(in srgb, var(--vscode-sideBar-background) 88%, var(--vscode-editor-background));
  }

  .mcp-panel-attention {
    border-color: var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border));
  }

  .mcp-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .mcp-title {
    font-weight: 600;
  }

  .mcp-summary {
    margin-top: 2px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.8em;
  }

  .mcp-servers {
    display: grid;
    gap: 8px;
  }

  .mcp-server {
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
    border-radius: 4px;
    background: color-mix(in srgb, var(--vscode-input-background) 72%, transparent);
  }

  .mcp-server-summary {
    display: grid;
    grid-template-columns: 10px minmax(0, auto) minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    padding: 8px;
    cursor: pointer;
    list-style: none;
  }

  .mcp-server-summary::-webkit-details-marker,
  .mcp-tool-summary::-webkit-details-marker {
    display: none;
  }

  .mcp-status {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--vscode-descriptionForeground);
  }

  .mcp-status-connected {
    background: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
  }

  .mcp-status-warn {
    background: var(--vscode-notificationsWarningIcon-foreground, var(--vscode-editorWarning-foreground));
  }

  .mcp-status-fail {
    background: var(--vscode-errorForeground);
  }

  .mcp-server-name {
    font-size: 0.86em;
    font-weight: 600;
  }

  .mcp-server-meta,
  .mcp-tool-count,
  .mcp-server-detail,
  .mcp-server-command,
  .mcp-tool-description {
    color: var(--vscode-descriptionForeground);
    font-size: 0.78em;
  }

  .mcp-server-meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mcp-server-body {
    display: grid;
    gap: 8px;
    padding: 0 8px 8px;
  }

  .mcp-tools {
    display: grid;
    gap: 6px;
  }

  .mcp-tool {
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 65%, transparent);
    border-radius: 4px;
    background: color-mix(in srgb, var(--vscode-editor-background) 80%, var(--vscode-input-background));
  }

  .mcp-tool-summary {
    display: grid;
    gap: 4px;
    padding: 8px;
    cursor: pointer;
    list-style: none;
  }

  .mcp-tool-name {
    font-size: 0.83em;
    font-weight: 600;
  }

  .mcp-tool-schema {
    margin: 0;
    padding: 0 8px 8px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 0.76em;
    color: var(--vscode-foreground);
  }

  .extension-panel {
    display: grid;
    gap: 10px;
    margin-bottom: 12px;
    padding: 10px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    background: color-mix(in srgb, var(--vscode-sideBar-background) 88%, var(--vscode-editor-background));
  }

  .extension-panel-attention {
    border-color: var(--vscode-editorWarning-foreground, var(--vscode-notificationsWarningIcon-foreground));
  }

  .extension-header,
  .extension-install-row,
  .extension-card-summary,
  .extension-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .extension-header {
    justify-content: space-between;
  }

  .extension-title,
  .extension-name {
    font-weight: 600;
  }

  .extension-summary,
  .extension-detail,
  .extension-meta,
  .extension-empty,
  .extension-warning,
  .extension-warning-list {
    color: var(--vscode-descriptionForeground);
    font-size: 0.8em;
    line-height: 1.35;
  }

  .extension-install-row input {
    min-width: 0;
    flex: 1 1 auto;
    height: 28px;
  }

  .extension-warning,
  .extension-warning-list,
  .extension-empty {
    padding: 8px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    background: color-mix(in srgb, var(--vscode-input-background) 72%, transparent);
  }

  .extension-list {
    display: grid;
    gap: 8px;
  }

  .extension-card {
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
    border-radius: 4px;
    background: color-mix(in srgb, var(--vscode-input-background) 72%, transparent);
  }

  .extension-card-summary {
    display: grid;
    grid-template-columns: 10px minmax(0, auto) minmax(0, 1fr);
    padding: 8px;
    cursor: pointer;
    list-style: none;
  }

  .extension-card-summary::-webkit-details-marker {
    display: none;
  }

  .extension-card-body {
    display: grid;
    gap: 8px;
    padding: 0 8px 8px;
  }

  .extension-status {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--vscode-descriptionForeground);
  }

  .extension-status-enabled {
    background: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
  }

  .extension-status-disabled {
    background: var(--vscode-editorWarning-foreground, var(--vscode-notificationsWarningIcon-foreground));
  }

  .extension-meta,
  .extension-detail,
  .extension-contribution span:last-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .extension-contributions {
    display: grid;
    gap: 4px;
  }

  .extension-contribution {
    display: grid;
    grid-template-columns: 72px minmax(0, 1fr);
    gap: 8px;
    padding: 4px 6px;
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 60%, transparent);
    border-radius: 4px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.78em;
  }

  .extension-actions {
    flex-wrap: wrap;
  }

  .context-dashboard {
    display: grid;
    gap: 10px;
    margin-bottom: 12px;
    padding: 10px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    background: color-mix(in srgb, var(--vscode-sideBar-background) 88%, var(--vscode-editor-background));
  }

  .context-dashboard-warning {
    border-color: var(--vscode-editorWarning-foreground, var(--vscode-notificationsWarningIcon-foreground));
  }

  .context-dashboard-critical {
    border-color: var(--vscode-errorForeground);
  }

  .context-dashboard-header,
  .context-pressure-row,
  .context-source-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .context-dashboard-title,
  .context-source-title {
    font-weight: 600;
  }

  .context-dashboard-summary,
  .context-pressure-detail,
  .context-source-detail,
  .context-empty {
    color: var(--vscode-descriptionForeground);
    font-size: 0.8em;
    line-height: 1.35;
  }

  .context-pressure-row,
  .context-empty {
    padding: 8px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    background: color-mix(in srgb, var(--vscode-input-background) 72%, transparent);
  }

  .context-pressure-dot {
    width: 8px;
    height: 8px;
    flex: 0 0 auto;
    border-radius: 50%;
    background: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
  }

  .context-pressure-warning {
    background: var(--vscode-editorWarning-foreground, var(--vscode-notificationsWarningIcon-foreground));
  }

  .context-pressure-critical {
    background: var(--vscode-errorForeground);
  }

  .context-source-list {
    display: grid;
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
    border-radius: 4px;
    background: color-mix(in srgb, var(--vscode-input-background) 72%, transparent);
  }

  .context-source-row {
    min-width: 0;
    padding: 8px;
    border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 55%, transparent);
  }

  .context-source-row:last-child {
    border-bottom: 0;
  }

  .context-source-row > div {
    min-width: 0;
  }

  .context-source-detail {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .context-origin {
    flex: 0 0 auto;
    padding: 2px 6px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 999px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.72em;
  }

  .checkpoint-panel {
    display: grid;
    gap: 10px;
    margin-bottom: 12px;
    padding: 10px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    background: color-mix(in srgb, var(--vscode-sideBar-background) 88%, var(--vscode-editor-background));
  }

  .checkpoint-panel-attention {
    border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
  }

  .checkpoint-header,
  .checkpoint-row,
  .checkpoint-save {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .checkpoint-title,
  .checkpoint-row-title,
  .checkpoint-group summary {
    font-weight: 600;
  }

  .checkpoint-summary,
  .checkpoint-row-detail,
  .checkpoint-empty,
  .checkpoint-warning {
    color: var(--vscode-descriptionForeground);
    font-size: 0.8em;
    line-height: 1.35;
  }

  .checkpoint-warning,
  .checkpoint-error,
  .checkpoint-empty {
    padding: 8px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    background: color-mix(in srgb, var(--vscode-input-background) 72%, transparent);
  }

  .checkpoint-warning {
    border-color: var(--vscode-editorWarning-foreground, var(--vscode-notificationsWarningIcon-foreground));
  }

  .checkpoint-error {
    color: var(--vscode-errorForeground);
  }

  .checkpoint-save input {
    min-width: 0;
    flex: 1 1 auto;
    padding: 6px 8px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 4px;
    font: inherit;
  }

  .checkpoint-group {
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
    border-radius: 4px;
    background: color-mix(in srgb, var(--vscode-input-background) 72%, transparent);
  }

  .checkpoint-group summary {
    padding: 8px;
    cursor: pointer;
    list-style: none;
  }

  .checkpoint-group summary::-webkit-details-marker {
    display: none;
  }

  .checkpoint-list {
    display: grid;
    gap: 1px;
    border-top: 1px solid var(--vscode-panel-border);
  }

  .checkpoint-row {
    min-width: 0;
    padding: 8px;
  }

  .checkpoint-row > div {
    min-width: 0;
  }

  .checkpoint-row-title,
  .checkpoint-row-detail {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .memory-panel {
    display: grid;
    gap: 10px;
    margin-bottom: 12px;
    padding: 10px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    background: color-mix(in srgb, var(--vscode-sideBar-background) 88%, var(--vscode-editor-background));
  }

  .memory-panel-attention {
    border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
  }

  .memory-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .memory-title,
  .memory-source-title,
  .memory-label {
    font-weight: 600;
  }

  .memory-summary,
  .memory-source-detail {
    margin-top: 2px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.8em;
    line-height: 1.35;
  }

  .memory-error,
  .memory-empty,
  .memory-confirm {
    display: grid;
    gap: 8px;
    padding: 8px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    background: color-mix(in srgb, var(--vscode-input-background) 72%, transparent);
  }

  .memory-error {
    color: var(--vscode-errorForeground);
  }

  .memory-sources {
    display: grid;
    gap: 8px;
  }

  .memory-source {
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
    border-radius: 4px;
    background: color-mix(in srgb, var(--vscode-input-background) 72%, transparent);
  }

  .memory-source-summary {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    padding: 8px;
    cursor: pointer;
    list-style: none;
  }

  .memory-source-summary::-webkit-details-marker {
    display: none;
  }

  .memory-path {
    min-width: 0;
    padding: 0;
    overflow: hidden;
    color: var(--vscode-textLink-foreground);
    background: transparent;
    border: 0;
    font-size: 0.8em;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .memory-content {
    max-height: 240px;
    overflow: auto;
    margin: 0;
    padding: 8px;
    color: var(--vscode-editor-foreground);
    background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
    border-top: 1px solid var(--vscode-panel-border);
    font-size: 0.8em;
    white-space: pre-wrap;
  }

  .memory-add {
    display: grid;
    gap: 6px;
  }

  .memory-textarea {
    min-height: 72px;
    resize: vertical;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 4px;
    padding: 8px;
    font: inherit;
  }

  .memory-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .prompt-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
    margin-top: 8px;
  }

  .prompt-chip {
    min-width: auto;
    min-height: auto;
    padding: 6px 12px;
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 16px;
    cursor: pointer;
    transition: background 150ms ease-out, color 150ms ease-out;
  }

  .prompt-chip:hover {
    color: var(--vscode-foreground);
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .message {
    display: grid;
    gap: 6px;
    margin-bottom: 18px;
    line-height: 1.5;
  }

  .message-author {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .pending-cancel {
    all: unset;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-panel-border);
  }

  .pending-cancel:hover {
    background: var(--vscode-inputValidation-errorBackground, color-mix(in srgb, var(--vscode-errorForeground) 18%, transparent));
    color: var(--vscode-errorForeground);
    border-color: var(--vscode-errorForeground);
  }

  .message-pending {
    opacity: 0.55;
  }

  .message-pending .message-user,
  .message-pending.message-user {
    border-style: dashed;
  }

  .message-content {
    overflow-wrap: anywhere;
  }

  .message-user {
    padding: 10px 12px;
    border-radius: 6px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-focusBorder, var(--vscode-input-border, var(--vscode-panel-border)));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-foreground) 4%, transparent);
  }

  .message-assistant {
    border-left: 2px solid var(--vscode-focusBorder);
    padding-left: 10px;
  }

  .message-tool {
    margin-bottom: 10px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
  }

  .message-tool .message-content {
    padding: 4px 8px;
    border-left: 2px solid var(--vscode-descriptionForeground);
    background: var(--vscode-input-background);
  }

  .message-error {
    margin-bottom: 10px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
  }

  .message-error .message-author {
    color: var(--vscode-errorForeground);
  }

  .message-warning {
    padding: 12px 14px;
    margin: 10px 0 12px;
    font-size: 0.9em;
    line-height: 1.45;
    color: var(--vscode-foreground);
    border-left: 2px solid var(--vscode-editorWarning-foreground, var(--vscode-notificationsWarningIcon-foreground));
    background: color-mix(in srgb, var(--vscode-editorWarning-foreground, var(--vscode-notificationsWarningIcon-foreground)) 10%, var(--vscode-input-background));
  }

  .message-warning .message-author {
    color: var(--vscode-editorWarning-foreground, var(--vscode-notificationsWarningIcon-foreground));
  }

  .message-warning .message-author::before {
    content: "\\26A0";
    margin-right: 4px;
  }

  .message-error .message-content {
    padding: 4px 8px;
    border-left: 2px solid var(--vscode-errorForeground);
    background: var(--vscode-input-background);
  }

  .message-content p,
  .message-content ul,
  .message-content h1,
  .message-content h2,
  .message-content h3,
  .message-content pre {
    margin: 0 0 10px;
  }

  .message-content p:last-child,
  .message-content ul:last-child,
  .message-content h1:last-child,
  .message-content h2:last-child,
  .message-content h3:last-child,
  .message-content pre:last-child {
    margin-bottom: 0;
  }

  .message-content h1 {
    font-size: 1.3em;
    line-height: 1.25;
  }

  .message-content h2 {
    font-size: 1.15em;
    line-height: 1.3;
  }

  .message-content h3 {
    font-size: 1em;
    line-height: 1.35;
  }

  .message-content ul {
    padding-left: 18px;
  }

  .message-content a {
    color: var(--vscode-textLink-foreground);
  }

  .code-block {
    overflow-x: auto;
    padding: 8px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
    white-space: pre-wrap;
  }

  .code-block-wrapper {
    position: relative;
  }

  .copy-button {
    position: absolute;
    top: 4px;
    right: 4px;
    padding: 2px 8px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 150ms ease-out;
  }

  .code-block-wrapper:hover .copy-button {
    opacity: 1;
  }

  .copy-button:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .diff-stage-button {
    opacity: 1;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border-color: var(--vscode-button-border, transparent);
  }

  .diff-block {
    padding-right: 140px;
  }

  .diff-line {
    display: block;
    min-width: max-content;
  }

  .diff-add {
    color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green));
    background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green)) 12%, transparent);
  }

  .diff-del {
    color: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-errorForeground));
    background: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-errorForeground)) 12%, transparent);
  }

  .diff-hunk {
    color: var(--vscode-textLink-foreground);
    background: color-mix(in srgb, var(--vscode-textLink-foreground) 10%, transparent);
  }

  .change-timeline {
    margin-top: 10px;
    padding: 8px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    background: color-mix(in srgb, var(--vscode-editor-background) 80%, var(--vscode-focusBorder) 8%);
  }

  .change-timeline summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    cursor: pointer;
    font-weight: 600;
  }

  .change-list {
    display: grid;
    gap: 4px;
    margin-top: 8px;
    font-size: 0.9em;
  }

  .change-file {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 0;
    border-top: 1px solid color-mix(in srgb, var(--vscode-foreground) 10%, transparent);
  }

  .change-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .change-counts {
    flex: 0 0 auto;
    color: var(--vscode-descriptionForeground);
    font-variant-numeric: tabular-nums;
  }

  .rollback-button {
    margin-top: 8px;
  }

  .message-action-btn {
    all: unset;
    min-width: auto;
    min-height: auto;
    padding: 1px 6px;
    font-size: 0.75em;
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 150ms ease-out;
  }

  .message:hover .message-action-btn {
    opacity: 1;
  }

  .message-action-btn:hover {
    color: var(--vscode-foreground);
    background: var(--vscode-toolbar-hoverBackground, color-mix(in srgb, var(--vscode-foreground) 10%, transparent));
  }

  .retry-button {
    margin-top: 6px;
    width: auto;
    align-self: start;
    opacity: 0;
    transition: opacity 150ms ease-out;
  }

  .message:hover .retry-button,
  .retry-button:focus-visible {
    opacity: 1;
  }

  .composer {
    display: grid;
    gap: 6px;
    padding: 8px 12px 10px;
    border-top: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border));
  }

  .composer-drag-active {
    outline: 2px dashed var(--vscode-focusBorder);
    outline-offset: -6px;
    background: color-mix(in srgb, var(--vscode-focusBorder) 10%, var(--vscode-sideBar-background));
  }

  .composer-notice {
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    gap: 8px;
    min-height: 34px;
    margin: -8px -12px 2px;
    padding: 7px 12px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px 8px 0 0;
    color: var(--vscode-foreground);
    background: color-mix(in srgb, var(--vscode-focusBorder) 14%, var(--vscode-editor-background));
  }

  .composer-notice-info {
    border-color: color-mix(in srgb, var(--vscode-focusBorder) 45%, var(--vscode-panel-border));
    background: color-mix(in srgb, var(--vscode-focusBorder) 12%, var(--vscode-editor-background));
  }

  .composer-notice-warning {
    border-color: var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground));
    background: var(--vscode-inputValidation-warningBackground, color-mix(in srgb, var(--vscode-editorWarning-foreground, var(--vscode-notificationsWarningIcon-foreground)) 14%, var(--vscode-editor-background)));
    color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
    font-size: 0.85em;
  }

  .composer-notice-error {
    border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
    background: var(--vscode-inputValidation-errorBackground, color-mix(in srgb, var(--vscode-errorForeground) 14%, var(--vscode-editor-background)));
  }

  .composer-notice-action,
  .composer-notice-dismiss {
    min-width: auto;
    min-height: 22px;
    padding: 0 6px;
    color: var(--vscode-descriptionForeground);
    background: transparent;
    border: 0;
    text-decoration: underline;
  }

  .composer-notice-action:disabled {
    cursor: default;
    opacity: 0.9;
  }

  .composer-notice-dismiss {
    text-decoration: none;
    font-size: 16px;
    line-height: 1;
  }

  .attachment-preview-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    overflow-x: auto;
    padding: 4px 0;
  }

  .image-preview-row {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding: 2px 0;
  }

  .image-preview-card {
    position: relative;
    display: grid;
    grid-template-rows: 58px auto;
    gap: 4px;
    width: 82px;
    padding: 4px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    background: var(--vscode-input-background);
  }

  .image-preview-card img {
    width: 100%;
    height: 58px;
    object-fit: cover;
    border-radius: 4px;
    background: var(--vscode-editor-background);
  }

  .image-preview-card span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--vscode-descriptionForeground);
    font-size: 0.75em;
  }

  .image-remove {
    position: absolute;
    top: 2px;
    right: 2px;
    min-width: 20px;
    width: 20px;
    min-height: 20px;
    height: 20px;
    padding: 0;
    border-radius: 50%;
    color: var(--vscode-button-foreground);
    background: color-mix(in srgb, var(--vscode-editor-background) 30%, var(--vscode-button-background));
  }

  .file-ref-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 6px 3px 8px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    background: var(--vscode-input-background);
    font-size: 0.82em;
    max-width: 180px;
  }

  .file-ref-icon {
    display: flex;
    flex-shrink: 0;
    color: var(--vscode-descriptionForeground);
  }

  .file-ref-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--vscode-foreground);
  }

  .file-ref-remove {
    flex-shrink: 0;
    min-width: 18px;
    width: 18px;
    min-height: 18px;
    height: 18px;
    padding: 0;
    border-radius: 50%;
    font-size: 12px;
    line-height: 1;
    color: var(--vscode-descriptionForeground);
    background: transparent;
    border: none;
    cursor: pointer;
  }

  .file-ref-remove:hover {
    color: var(--vscode-errorForeground);
    background: color-mix(in srgb, var(--vscode-errorForeground) 15%, transparent);
  }

  .slash-popover {
    display: grid;
    gap: 2px;
    max-height: 220px;
    overflow-y: auto;
    padding: 4px;
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 6px;
    background: var(--vscode-dropdown-background, var(--vscode-input-background));
    box-shadow: 0 8px 24px var(--vscode-widget-shadow, color-mix(in srgb, var(--vscode-foreground) 22%, transparent));
  }

  .slash-option {
    display: grid;
    grid-template-columns: minmax(90px, auto) 1fr auto;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: auto;
    min-width: 0;
    padding: 6px 8px;
    text-align: left;
    color: var(--vscode-foreground);
    background: transparent;
    border: 0;
    border-radius: 4px;
  }

  .slash-option:hover,
  .slash-option-active {
    background: var(--vscode-list-hoverBackground, var(--vscode-toolbar-hoverBackground));
  }

  .slash-name {
    font-family: var(--vscode-editor-font-family);
    font-size: 0.88em;
    color: var(--vscode-textLink-foreground);
    white-space: nowrap;
  }

  .slash-description {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--vscode-descriptionForeground);
    font-size: 0.82em;
  }

  .slash-kind {
    color: var(--vscode-descriptionForeground);
    font-size: 0.7em;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 10px;
    padding: 1px 6px;
    white-space: nowrap;
  }

  textarea {
    width: 100%;
    min-height: 40px;
    max-height: 180px;
    resize: none;
    overflow-y: auto;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 6px;
    padding: 8px;
    font: inherit;
    line-height: 1.4;
  }

  textarea:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-focusBorder) 22%, transparent);
  }

  textarea:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    background: var(--vscode-sideBar-background);
  }

  .thinking-indicator {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 0;
    color: var(--vscode-descriptionForeground);
  }

  .thinking-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .thinking-stall-hint {
    padding: 10px 12px;
    border-radius: 4px;
    border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-notificationsWarningIcon-foreground));
    background: color-mix(in srgb, var(--vscode-editorWarning-foreground, var(--vscode-notificationsWarningIcon-foreground)) 16%, var(--vscode-editor-background));
    color: var(--vscode-foreground);
    font-size: 0.9em;
    line-height: 1.4;
  }

  .thinking-logo {
    width: 20px;
    height: 20px;
    flex: 0 0 20px;
    color: var(--vscode-charts-blue, var(--vscode-progressBar-background));
    animation: pulse-spin 2s ease-in-out infinite;
  }

  .thinking-logo svg,
  .thinking-logo img {
    width: 100%;
    height: 100%;
    display: block;
  }

  @keyframes pulse-spin {
    0% { opacity: 0.6; transform: scale(1) rotate(0deg); }
    50% { opacity: 1; transform: scale(1.15) rotate(180deg); }
    100% { opacity: 0.6; transform: scale(1) rotate(360deg); }
  }

  .thinking-text {
    font-size: 0.85em;
    font-style: italic;
    animation: typewriter-fade 0.6s ease-out;
  }

  .thinking-elapsed {
    margin-left: auto;
    font-size: 0.72em;
    font-variant-numeric: tabular-nums;
    padding: 2px 8px;
    border-radius: 10px;
    border: 1px solid var(--vscode-panel-border);
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-input-background);
    white-space: nowrap;
  }

  @keyframes typewriter-fade {
    0% { opacity: 0; transform: translateX(-4px); }
    100% { opacity: 1; transform: translateX(0); }
  }

  .composer-controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 6px 8px;
  }

  .controls-left {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
    flex: 1 1 auto;
  }

  .controls-right {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
    flex: 0 1 auto;
    min-width: 0;
    margin-left: auto;
  }

  .compact-select {
    min-width: 0;
    max-width: 140px;
    height: 32px;
    padding: 0 22px 0 8px;
    font-size: 0.8em;
    line-height: 32px;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 4px;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .compact-select:hover {
    color: var(--vscode-foreground);
  }

  .context-chip,
  .context-mcp-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 32px;
    min-height: 32px;
    padding: 0 8px;
    font-size: 0.8em;
    line-height: 1;
    border-radius: 999px;
  }

  .context-chip {
    min-width: auto;
    color: var(--vscode-descriptionForeground);
    background: transparent;
    border: 1px solid var(--vscode-panel-border);
  }

  .context-chip:hover {
    color: var(--vscode-foreground);
    background: var(--vscode-toolbar-hoverBackground, color-mix(in srgb, var(--vscode-foreground) 8%, transparent));
  }

  .context-mcp-badge {
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-panel-border);
    background: color-mix(in srgb, var(--vscode-focusBorder) 12%, transparent);
  }

  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 72px;
    min-height: 32px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 4px;
    padding: 0 12px;
    line-height: 1;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    font: inherit;
    cursor: pointer;
  }

  .btn-secondary {
    min-width: auto;
    color: var(--vscode-button-secondaryForeground, var(--vscode-descriptionForeground));
    background: var(--vscode-button-secondaryBackground, transparent);
    border-color: var(--vscode-panel-border);
    font-size: 0.85em;
  }

  button:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground);
  }

  button:disabled {
    cursor: default;
    opacity: 0.55;
  }

  /* Context window meter — always-visible ring beside Send (Grok-style donut) */
  .context-meter {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: auto;
    min-height: 32px;
    height: 32px;
    padding: 0 6px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    font-size: 0.74em;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    white-space: nowrap;
  }

  .context-meter:hover:not(:disabled) {
    background: var(--vscode-toolbar-hoverBackground, color-mix(in srgb, var(--vscode-foreground) 8%, transparent));
  }

  .context-meter svg {
    flex: 0 0 auto;
  }

  .context-meter-idle {
    opacity: 0.7;
  }

  .context-meter-normal {
    color: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
  }

  .context-meter-warning {
    color: var(--vscode-editorWarning-foreground, var(--vscode-notificationsWarningIcon-foreground));
  }

  .context-meter-critical {
    color: var(--vscode-errorForeground);
  }

  .context-meter-label {
    color: var(--vscode-descriptionForeground);
  }

  .advanced-toggle {
    border: 0;
    background: transparent;
  }

  .advanced-toggle-on {
    color: var(--vscode-foreground);
    background: var(--vscode-toolbar-hoverBackground, color-mix(in srgb, var(--vscode-foreground) 10%, transparent));
  }

  .composer-controls-advanced {
    padding-top: 2px;
  }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--vscode-editor-background) 68%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 16px;
  }

  .modal {
    width: 100%;
    max-width: 520px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    background: var(--vscode-sideBar-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    box-shadow: 0 10px 40px var(--vscode-widget-shadow, color-mix(in srgb, var(--vscode-foreground) 28%, transparent));
    overflow: hidden;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  .modal-header h2 {
    margin: 0;
    font-size: 1em;
    font-weight: 600;
  }

  .modal-body {
    padding: 12px 16px 16px;
    overflow-y: auto;
    display: grid;
    gap: 14px;
  }

  .modal-body section h3 {
    margin: 0 0 6px;
    font-size: 0.9em;
    font-weight: 600;
    color: var(--vscode-descriptionForeground);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .modal-body ul {
    margin: 0;
    padding-left: 18px;
  }

  .modal-body li {
    margin-bottom: 4px;
  }

  .modal-body code {
    background: var(--vscode-input-background);
    padding: 1px 5px;
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family);
    font-size: 0.88em;
  }

  .modal-body kbd {
    padding: 1px 5px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px;
    background: var(--vscode-input-background);
    font-family: var(--vscode-editor-font-family);
    font-size: 0.82em;
  }

  /* Inline code */
  .inline-code {
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--vscode-textCodeBlock-background, var(--vscode-input-background));
    font-family: var(--vscode-editor-font-family);
    font-size: 0.9em;
  }

  /* Blockquotes */
  blockquote {
    margin: 8px 0;
    padding: 4px 12px;
    border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-panel-border));
    color: var(--vscode-textBlockQuote-foreground, var(--vscode-descriptionForeground));
    background: var(--vscode-textBlockQuote-background, transparent);
  }

  /* Tables */
  .table-wrapper {
    overflow-x: auto;
    margin: 8px 0;
  }

  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.9em;
  }

  th, td {
    padding: 4px 8px;
    border: 1px solid var(--vscode-panel-border);
    text-align: left;
  }

  th {
    font-weight: 600;
    background: color-mix(in srgb, var(--vscode-sideBar-background) 85%, var(--vscode-foreground) 15%);
  }

  tr:nth-child(even) {
    background: color-mix(in srgb, var(--vscode-sideBar-background) 95%, var(--vscode-foreground) 5%);
  }

  /* Horizontal rules */
  hr {
    border: none;
    border-top: 1px solid var(--vscode-panel-border);
    margin: 12px 0;
  }

  /* Ordered lists */
  ol {
    margin: 4px 0;
    padding-left: 1.5em;
  }

  ol li {
    margin: 2px 0;
  }

  /* Strikethrough */
  del {
    text-decoration: line-through;
    opacity: 0.7;
  }

  /* Thinking sections */
  .thinking-section {
    margin: 4px 0 8px 0;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    overflow: hidden;
  }

  .thinking-summary {
    cursor: pointer;
    padding: 4px 8px;
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    background: color-mix(in srgb, var(--vscode-sideBar-background) 90%, var(--vscode-foreground) 10%);
    user-select: none;
  }

  .thinking-summary:hover {
    color: var(--vscode-foreground);
  }

  .thinking-content {
    padding: 8px 12px;
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 300px;
    overflow-y: auto;
    background: color-mix(in srgb, var(--vscode-sideBar-background) 95%, var(--vscode-foreground) 5%);
  }

  /* Permission cards */
  .message-permission {
    border-left: 3px solid var(--vscode-editorWarning-foreground, var(--vscode-notificationsWarningIcon-foreground));
    padding-left: 12px;
  }

  .message-permission.permission-resolved {
    border-left-color: var(--vscode-descriptionForeground);
    opacity: 0.7;
  }

  .permission-card {
    padding: 6px 0 2px;
  }

  .permission-tool-name {
    font-weight: 600;
    font-family: var(--vscode-editor-font-family);
    margin: 6px 0 10px;
    font-size: 1.05em;
    line-height: 1.35;
  }

  .permission-args {
    margin: 4px 0 8px 0;
    padding: 6px 8px;
    font-size: 0.85em;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px;
    max-height: 150px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .permission-buttons {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 6px;
  }

  .permission-btn {
    min-height: 34px;
    padding: 0 14px;
    border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
    border-radius: 3px;
    background: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    cursor: pointer;
    font-size: 0.9em;
  }

  .permission-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground));
  }

  .permission-btn-allow {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-border, transparent);
  }

  .permission-btn-allow:hover {
    background: var(--vscode-button-hoverBackground);
  }

  .permission-btn-reject {
    border-color: var(--vscode-errorForeground);
    color: var(--vscode-errorForeground);
  }

  .permission-resolved-label {
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    padding: 4px 0;
  }

  /* Phase 39 W3 — Local/Search segmented pill */
  .search-mode-pill {
    display: inline-flex;
    align-items: stretch;
    height: 32px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 999px;
    overflow: hidden;
    background: var(--vscode-input-background);
  }

  .search-mode-segment {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    padding: 0 12px;
    font-size: 0.78em;
    line-height: 1;
    color: var(--vscode-descriptionForeground);
    background: transparent;
    border: none;
    border-radius: 0;
    cursor: pointer;
  }

  .search-mode-segment + .search-mode-segment {
    border-left: 1px solid var(--vscode-panel-border);
  }

  .search-mode-segment:hover:not(:disabled) {
    color: var(--vscode-foreground);
    background: var(--vscode-toolbar-hoverBackground, color-mix(in srgb, var(--vscode-foreground) 8%, transparent));
  }

  .search-mode-segment-active {
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
  }

  .search-mode-segment-active:hover:not(:disabled) {
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
  }

  .search-mode-segment-unavailable {
    color: var(--vscode-descriptionForeground);
    opacity: 0.6;
    cursor: help;
  }

  .search-mode-segment:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Globe badge on grounded assistant turns */
  .search-mode-badge {
    display: inline-flex;
    align-items: center;
    margin-left: 6px;
    color: var(--vscode-descriptionForeground);
  }

  /* Phase 39 W3 — attachment chip variants (image card reuses existing styles) */
  .attachment-remove {
    flex-shrink: 0;
    min-width: 18px;
    width: 18px;
    min-height: 18px;
    height: 18px;
    padding: 0;
    border-radius: 50%;
    font-size: 12px;
    line-height: 1;
    color: var(--vscode-descriptionForeground);
    background: transparent;
    border: none;
    cursor: pointer;
  }

  .attachment-remove:hover {
    color: var(--vscode-foreground);
    background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
  }

  .pdf-chip {
    border-color: color-mix(in srgb, var(--vscode-textLink-foreground, var(--vscode-foreground)) 30%, var(--vscode-panel-border));
  }

  .pdf-tag {
    margin-left: 4px;
    padding: 1px 5px;
    font-size: 0.72em;
    border-radius: 3px;
    background: color-mix(in srgb, var(--vscode-textLink-foreground, var(--vscode-foreground)) 18%, transparent);
    color: var(--vscode-textLink-foreground, var(--vscode-foreground));
  }

  .unsupported-chip {
    border-color: var(--vscode-editorWarning-foreground, var(--vscode-errorForeground));
    background: color-mix(in srgb, var(--vscode-editorWarning-foreground, var(--vscode-errorForeground)) 10%, var(--vscode-input-background));
    max-width: 280px;
  }

  .unsupported-icon {
    color: var(--vscode-editorWarning-foreground, var(--vscode-errorForeground));
  }

  .unsupported-text {
    margin-left: 4px;
    font-size: 0.78em;
    color: var(--vscode-editorWarning-foreground, var(--vscode-errorForeground));
  }

  /* Phase 39 W3 — Sources section (mirrors thinking-section) */
  .sources-section {
    margin: 6px 0 8px 0;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    overflow: hidden;
  }

  .sources-summary {
    cursor: pointer;
    padding: 4px 8px;
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    background: color-mix(in srgb, var(--vscode-sideBar-background) 90%, var(--vscode-foreground) 10%);
    user-select: none;
  }

  .sources-summary:hover {
    color: var(--vscode-foreground);
  }

  .sources-list {
    list-style: none;
    margin: 0;
    padding: 6px 12px;
    font-size: 0.85em;
    background: color-mix(in srgb, var(--vscode-sideBar-background) 95%, var(--vscode-foreground) 5%);
  }

  .sources-list li {
    padding: 2px 0;
  }

  .sources-link {
    color: var(--vscode-textLink-foreground);
    text-decoration: none;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    font: inherit;
    text-align: left;
  }

  .sources-link:hover {
    text-decoration: underline;
  }

  .sources-host {
    color: var(--vscode-descriptionForeground);
    margin-left: 6px;
    font-size: 0.92em;
  }

  .sources-raw-toggle {
    margin: 4px 12px 8px;
    font-size: 0.78em;
    color: var(--vscode-descriptionForeground);
  }

  .sources-raw {
    margin: 0 12px 8px;
    padding: 6px 8px;
    border: 1px dashed var(--vscode-panel-border);
    border-radius: 3px;
    font-size: 0.78em;
    background: var(--vscode-textCodeBlock-background, var(--vscode-input-background));
    color: var(--vscode-descriptionForeground);
    white-space: pre-wrap;
    word-break: break-word;
    overflow-x: auto;
  }

  /* Phase 39 W3 — Sketch canvas inline panel */
  .sketch-panel {
    margin: 6px 0;
    padding: 8px;
    border: 1px dashed var(--vscode-panel-border);
    border-radius: 4px;
    background: color-mix(in srgb, var(--vscode-sideBar-background) 95%, var(--vscode-foreground) 5%);
  }

  .sketch-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
  }

  .sketch-canvas {
    display: block;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    cursor: crosshair;
    touch-action: none;
    max-width: 100%;
  }

  .sketch-swatch {
    width: 20px;
    height: 20px;
    min-width: 20px;
    border-radius: 50%;
    border: 1px solid var(--vscode-panel-border);
    cursor: pointer;
    padding: 0;
  }

  .sketch-swatch-active {
    outline: 2px solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }
`;
document.head.appendChild(style);
