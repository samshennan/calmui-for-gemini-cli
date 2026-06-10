import { describe, expect, it } from 'vitest';
import type { ChatState, ImageAttachment } from '../shared/messages';
import {
  buildComposerNotice,
  buildContextSources,
  buildContextUsage,
  checkpointActionsDisabled,
  getDiagnosticsActionLabel,
  getDiagnosticsProblems,
  getExtensionContributionCount,
  getExtensionSummary,
  getCheckpointSummary,
  getMcpActionLabel,
  getMcpProblemCount,
  getMemoryExistingSources,
  getMemorySourceLabel,
  isSafeCheckpointTag,
  isSafeExtensionName,
  isSafeExtensionUrl,
  memoryActionsDisabled,
  buildSendPayload,
  getDroppedFileUri,
  parseGeminiRestoreCheckpoints,
  parseManualCheckpointTags,
  parseSources,
  getVirtualWindow,
  VIRTUAL_MESSAGE_HEIGHT,
  VIRTUAL_THRESHOLD,
} from './viewModel';

function state(overrides: Partial<ChatState> = {}): ChatState {
  return {
    status: 'idle',
    connection: 'connected',
    messages: [],
    permissionMode: 'ask',
    model: 'auto',
    availableModels: [],
    availableCommands: [],
    gcloud: { account: null, project: null },
    // Phase 39 W3: searchMode is required on ChatState — default to 'local'
    // for tests that don't care about search mode.
    searchMode: 'local',
    ...overrides,
  };
}

describe('getVirtualWindow', () => {
  it('does not virtualize short transcripts', () => {
    expect(getVirtualWindow(VIRTUAL_THRESHOLD, 0, 600)).toEqual({
      enabled: false,
      start: 0,
      end: VIRTUAL_THRESHOLD,
      topPadding: 0,
      bottomPadding: 0,
    });
  });

  it('renders an overscanned window for long transcripts', () => {
    const win = getVirtualWindow(200, VIRTUAL_MESSAGE_HEIGHT * 30, 600);
    expect(win.enabled).toBe(true);
    expect(win.start).toBeLessThanOrEqual(30);
    expect(win.end).toBeGreaterThan(30);
    expect(win.topPadding).toBe(win.start * VIRTUAL_MESSAGE_HEIGHT);
    expect(win.bottomPadding).toBe((200 - win.end) * VIRTUAL_MESSAGE_HEIGHT);
  });

  it('clamps the window at the beginning and end', () => {
    expect(getVirtualWindow(100, 0, 600).start).toBe(0);
    expect(getVirtualWindow(100, VIRTUAL_MESSAGE_HEIGHT * 99, 600).end).toBe(100);
  });
});

describe('buildComposerNotice', () => {
  it('prioritizes transient image warnings', () => {
    expect(buildComposerNotice({
      chatState: state({ errorMessage: 'less important' }),
      imageInputMessage: 'Image input requires ACP mode.',
      connectionBlocksSend: false,
    })).toEqual({ level: 'warning', text: 'Image input requires ACP mode.' });
  });

  it('shows connection errors as error notices', () => {
    expect(buildComposerNotice({
      chatState: state({ connection: 'error' }),
      imageInputMessage: null,
      connectionBlocksSend: true,
      sendDisabledReason: 'Gemini ACP is disconnected.',
    })).toEqual({ level: 'error', text: 'Gemini ACP is disconnected.' });
  });

  it('shows gcloud auth as a warning when no ACP model session is active', () => {
    expect(buildComposerNotice({
      chatState: state({ gcloud: { account: null, project: null, errorMessage: 'auth missing' } }),
      imageInputMessage: null,
      connectionBlocksSend: false,
    })?.level).toBe('warning');
  });
});

describe('diagnostics view helpers', () => {
  it('returns only warning and failed diagnostics checks', () => {
    const problems = getDiagnosticsProblems({
      generatedAt: '2026-04-30T00:00:00.000Z',
      passed: 1,
      total: 3,
      checks: [
        { id: 'extension', label: 'Extension', status: 'pass', detail: 'ok' },
        { id: 'transport', label: 'Transport', status: 'warn', detail: 'legacy' },
        { id: 'gemini-cli', label: 'Gemini CLI', status: 'fail', detail: 'missing' },
      ],
    });

    expect(problems.map(check => check.id)).toEqual(['transport', 'gemini-cli']);
  });

  it('uses explicit labels for single diagnostics actions', () => {
    expect(getDiagnosticsActionLabel('runDiagnostics')).toBe('Run Diagnostics');
    expect(getDiagnosticsActionLabel('openVSCodeSettings')).toBe('Open Settings');
    expect(getDiagnosticsActionLabel('openGeminiSettings')).toBe('Open Gemini Settings');
    expect(getDiagnosticsActionLabel('refreshGcloud')).toBe('Refresh Auth');
    expect(getDiagnosticsActionLabel('retryAcp')).toBe('Retry ACP');
  });
});

describe('mcp view helpers', () => {
  it('counts only warning and failed MCP servers as problems', () => {
    expect(getMcpProblemCount({
      generatedAt: '2026-04-30T00:00:00.000Z',
      servers: [
        { name: 'ok', transport: 'stdio', status: 'connected', detail: 'ok', toolCount: 1, tools: [] },
        { name: 'warn', transport: 'stdio', status: 'warn', detail: 'warn', toolCount: 0, tools: [] },
        { name: 'fail', transport: 'stdio', status: 'fail', detail: 'fail', toolCount: 0, tools: [] },
      ],
    })).toBe(2);
  });

  it('uses explicit labels for MCP actions', () => {
    expect(getMcpActionLabel('refreshMcpInspector')).toBe('Rescan');
    expect(getMcpActionLabel('openGeminiSettings')).toBe('Open Gemini Settings');
    expect(getMcpActionLabel('retryAcp')).toBe('Retry ACP');
  });
});

describe('extension manager helpers', () => {
  const report = {
    generatedAt: '2026-04-30T00:00:00.000Z',
    warnings: ['bad manifest'],
    extensions: [
      {
        id: 'user:docs:/manifest',
        name: 'docs',
        sourceKind: 'user' as const,
        path: '/ext/docs',
        manifestPath: '/ext/docs/gemini-extension.json',
        status: 'enabled' as const,
        contributions: [
          { kind: 'mcp' as const, names: ['docs'] },
          { kind: 'command' as const, names: ['/docs', '/search'] },
        ],
      },
    ],
  };

  it('summarizes installed extensions and contributions', () => {
    expect(getExtensionContributionCount(report)).toBe(3);
    expect(getExtensionSummary(report)).toBe('1 extension, 3 contributions, 1 warning');
    expect(getExtensionSummary()).toBe('Extension Manager not loaded yet');
  });

  it('validates extension action inputs conservatively', () => {
    expect(isSafeExtensionName('google/docs-extension_1.0')).toBe(true);
    expect(isSafeExtensionName('../escape')).toBe(false);
    expect(isSafeExtensionUrl('https://github.com/example/ext.git')).toBe(true);
    expect(isSafeExtensionUrl('git@github.com:example/ext.git')).toBe(true);
    expect(isSafeExtensionUrl('file:///tmp/ext')).toBe(false);
  });
});

describe('memory view helpers', () => {
  it('labels memory sources explicitly', () => {
    expect(getMemorySourceLabel('project')).toBe('Project');
    expect(getMemorySourceLabel('ancestor')).toBe('Ancestor');
    expect(getMemorySourceLabel('global')).toBe('Global');
  });

  it('returns only existing memory sources', () => {
    expect(getMemoryExistingSources({
      status: 'idle',
      sources: [
        { path: 'GEMINI.md', kind: 'project', exists: true, content: 'project' },
        { path: '~/.gemini/GEMINI.md', kind: 'global', exists: false, content: '' },
      ],
    }).map(source => source.path)).toEqual(['GEMINI.md']);
  });

  it('disables memory mutations while Gemini is busy or disconnected', () => {
    expect(memoryActionsDisabled(state({ status: 'receiving' }))).toBe(true);
    expect(memoryActionsDisabled(state({ connection: 'disconnected' }))).toBe(true);
    expect(memoryActionsDisabled(state())).toBe(false);
  });
});

describe('checkpoint view helpers', () => {
  it('summarizes grouped checkpoint sources', () => {
    expect(getCheckpointSummary({
      status: 'idle',
      nativeSessions: [{ id: 's1', title: 'Session', createdAt: '2026-04-30T00:00:00.000Z', messageCount: 2 }],
      manualCheckpoints: [{ tag: 'before-refactor' }],
      restoreCheckpoints: [{ id: '2026-04-30T10-00-00_000Z-file-write_file' }],
      turnRestorePoints: [{ turnId: 1, filesChanged: 1, additions: 4, deletions: 2, rollbackAvailable: true }],
      dirtyWorktree: false,
    })).toBe('1 native, 1 saved, 1 restore, 1 turn rollback');
  });

  it('parses manual checkpoint tags from Gemini CLI output', () => {
    expect(parseManualCheckpointTags([
      'Available checkpoints:',
      '- before-refactor',
      '* release_1.5',
      'tag: decision.point',
    ].join('\n')).map(item => item.tag)).toEqual(['before-refactor', 'release_1.5', 'decision.point']);
  });

  it('parses Gemini restore checkpoint ids from restore output', () => {
    expect(parseGeminiRestoreCheckpoints([
      'Available checkpoints:',
      '2026-04-30T10-00-00_000Z-src-app.ts-write_file',
      '- checkpoint-abc123',
    ].join('\n')).map(item => item.id)).toEqual([
      '2026-04-30T10-00-00_000Z-src-app.ts-write_file',
      'checkpoint-abc123',
    ]);
  });

  it('validates checkpoint tags conservatively', () => {
    expect(isSafeCheckpointTag('before-refactor_1.5')).toBe(true);
    expect(isSafeCheckpointTag('bad tag')).toBe(false);
    expect(isSafeCheckpointTag('../escape')).toBe(false);
  });

  it('disables checkpoint actions while Gemini is busy or disconnected', () => {
    expect(checkpointActionsDisabled(state({ status: 'receiving' }))).toBe(true);
    expect(checkpointActionsDisabled(state({ connection: 'reconnecting' }))).toBe(true);
    expect(checkpointActionsDisabled(state())).toBe(false);
  });
});

describe('context dashboard helpers', () => {
  it('marks context pressure at normal, warning, and critical thresholds', () => {
    expect(buildContextUsage(100_000, 'gemini-3.1-pro-preview')?.level).toBe('normal');
    expect(buildContextUsage(800_000, 'gemini-3.1-pro-preview')?.level).toBe('warning');
    expect(buildContextUsage(950_000, 'gemini-3.1-pro-preview')?.level).toBe('critical');
  });

  it('labels model limits as estimates when derived from known model families', () => {
    const usage = buildContextUsage(24_000, 'models/gemini-2.5-pro');
    expect(usage?.estimated).toBe(true);
    expect(usage?.label).toContain('/ 1.05M');
  });

  it('returns no pressure info for unknown model limits', () => {
    expect(buildContextUsage(24_000, 'custom-model')).toBeNull();
  });

  it('rejects non-finite and negative token totals', () => {
    expect(buildContextUsage(Number.NaN, 'gemini-2.5-pro')).toBeNull();
    expect(buildContextUsage(Number.POSITIVE_INFINITY, 'gemini-2.5-pro')).toBeNull();
    expect(buildContextUsage(-1, 'gemini-2.5-pro')).toBeNull();
  });

  it('caps runaway percentages at 999', () => {
    expect(buildContextUsage(50_000_000_000, 'gemini-2.5-pro')?.percentage).toBe(999);
  });

  it('aggregates active context sources with origins', () => {
    const sources = buildContextSources({
      chatState: state({
        context: {
          activeFile: 'src/app.ts',
          hasSelection: true,
          selectionChars: 42,
          visibleFiles: ['src/app.ts', 'README.md'],
          mcpEnabled: true,
        },
        memory: {
          status: 'idle',
          sources: [
            { path: 'GEMINI.md', kind: 'project', exists: true, content: 'memory' },
          ],
        },
      }),
      fileRefs: ['@src/test.ts'],
      images: [{ id: '1', name: 'diagram.png', mimeType: 'image/png', data: 'abc' }],
    });

    expect(sources.map(source => [source.label, source.origin])).toEqual([
      ['GEMINI.md memory', 'Gemini-native'],
      ['Editor context server', 'MCP-served'],
      ['Active file', 'prompt-injected'],
      ['Selection', 'MCP-served'],
      ['Open editors', 'MCP-served'],
      ['File references', 'prompt-injected'],
      ['Images', 'Gemini-native'],
    ]);
  });
});

describe('buildSendPayload', () => {
  // Phase 39 W3: image attachments now flow through the AttachmentChip union.
  const imageChip = {
    kind: 'image' as const,
    id: '1',
    name: 'diagram.png',
    mimeType: 'image/png',
    data: 'abc',
  };

  it('returns no payload for empty text with no attachments', () => {
    expect(buildSendPayload('   ', [], true, 'local')).toEqual({ payload: null });
  });

  it('requires ACP mode for images', () => {
    expect(buildSendPayload('look', [imageChip], false, 'local').imageError).toContain('ACP mode');
  });

  it('uses default text for image-only prompts', () => {
    expect(buildSendPayload('', [imageChip], true, 'local').payload).toEqual({
      text: 'Please analyze the attached image(s).',
      searchMode: 'local',
      attachments: [imageChip],
    });
  });

  it('threads the active search mode through the payload', () => {
    expect(buildSendPayload('hello', [], true, 'grounded').payload).toEqual({
      text: 'hello',
      searchMode: 'grounded',
      attachments: undefined,
    });
  });

  it('blocks send when an unsupported chip is present', () => {
    const result = buildSendPayload('hi', [
      { kind: 'unsupported', id: 'u1', name: 'malware.exe', reason: 'Cannot be sent to Gemini' },
    ], true, 'local');
    expect(result.payload).toBeNull();
    expect(result.imageError).toContain('malware.exe');
  });
});

describe('getDroppedFileUri', () => {
  it('normalizes VS Code webview file paths', () => {
    const file = { path: 'C:\\repo\\src\\app.ts' } as File & { path: string };
    expect(getDroppedFileUri(file)).toBe('file:///C:/repo/src/app.ts');
  });

  it('falls back to webkitRelativePath when available', () => {
    const file = { webkitRelativePath: 'src/app.ts' } as File & { webkitRelativePath: string };
    expect(getDroppedFileUri(file)).toBe('file:///src/app.ts');
  });
});

// Phase 39 W5 — parseSources fixtures grounded in RESEARCH.md §3.3 sample.
// Live capture from Risk #2 is deferred to phase-end UAT (PLAN.md notes the
// degraded path), so the W0-spike fixture is left as `it.todo`.
describe('parseSources', () => {
  it('returns body, sources, and raw for a clean two-row footer (RESEARCH §3.3)', () => {
    const text = [
      'React 19 is now stable [1] and ships a new compiler [2].',
      '',
      'Sources:',
      '[1] React 19 release notes (https://react.dev/blog/2024/12/05/react-19)',
      '[2] React Compiler docs (https://react.dev/learn/react-compiler)',
    ].join('\n');

    const result = parseSources(text);
    expect(result.body).toBe('React 19 is now stable [1] and ships a new compiler [2].');
    expect(result.sources).toEqual([
      { index: 1, title: 'React 19 release notes', url: 'https://react.dev/blog/2024/12/05/react-19' },
      { index: 2, title: 'React Compiler docs', url: 'https://react.dev/learn/react-compiler' },
    ]);
    expect(result.raw).not.toBeNull();
    expect(result.raw).toContain('Sources:');
    expect(result.raw).toContain('[1] React 19 release notes');
    // Body must not still carry the footer or trailing whitespace.
    expect(result.body).not.toMatch(/Sources:/);
    expect(result.body).not.toMatch(/\s$/);
  });

  it('returns the original text with null sources/raw when no Sources footer exists', () => {
    const text = 'Plain assistant response without any citations.';
    const result = parseSources(text);
    expect(result).toEqual({ body: text, sources: null, raw: null });
  });

  it('returns null sources/raw when inline [N] markers exist but no footer', () => {
    // The W3 consumer renders no Sources section in this case (inline markers
    // remain but the collapsible Sources block is suppressed).
    const text = 'See [1][2] for context but the response was truncated';
    const result = parseSources(text);
    expect(result).toEqual({ body: text, sources: null, raw: null });
  });

  it('drops malformed rows from sources but preserves them verbatim in raw', () => {
    const text = [
      'Body text [1][2].',
      '',
      'Sources:',
      '[1] Good row (https://example.com/good)',
      '[2] Bad row missing parens https://example.com/bad',
    ].join('\n');

    const result = parseSources(text);
    expect(result.sources).toEqual([
      { index: 1, title: 'Good row', url: 'https://example.com/good' },
    ]);
    expect(result.raw).toContain('[2] Bad row missing parens');
    expect(result.body).toBe('Body text [1][2].');
  });

  it('returns null sources but non-null raw when every row is malformed (View raw path)', () => {
    const text = [
      'Body text [1].',
      '',
      'Sources:',
      '[1] no parens here https://example.com/x',
    ].join('\n');

    const result = parseSources(text);
    expect(result.sources).toBeNull();
    expect(result.raw).not.toBeNull();
    expect(result.raw).toContain('Sources:');
  });

  it('trims trailing whitespace from the body even when the footer ends with extra blank lines', () => {
    const text = [
      'Body with trailing whitespace footer [1].',
      '',
      'Sources:',
      '[1] T (https://example.com/a)',
      '',
      '',
      '',
    ].join('\n');

    const result = parseSources(text);
    expect(result.body).toBe('Body with trailing whitespace footer [1].');
    expect(result.sources).toHaveLength(1);
  });

  it.todo('live capture from W0 spike (PLAN.md Risk #2) — deferred to phase-end UAT');
});
