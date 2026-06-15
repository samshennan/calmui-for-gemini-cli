import type { ModelOption, PermissionMode, SlashCommand } from './messages';

export interface AcpMessage {
  jsonrpc: '2.0';
  method?: string;
  id?: number | string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Parse one newline-delimited ACP JSON-RPC message.
 * Gemini CLI ACP currently emits one JSON object per line; non-JSON startup
 * noise is ignored by returning null.
 */
export function parseAcpMessage(raw: string): AcpMessage | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || parsed.jsonrpc !== '2.0') return null;
    return parsed as AcpMessage;
  } catch {
    return null;
  }
}

export function adaptAcpSessionNewResult(result: unknown): unknown | null {
  if (!result || typeof result !== 'object') return null;
  const obj = result as {
    sessionId?: unknown;
    models?: { currentModelId?: unknown };
  };
  return {
    type: 'init',
    model: typeof obj.models?.currentModelId === 'string' ? obj.models.currentModelId : undefined,
    session_id: typeof obj.sessionId === 'string' ? obj.sessionId : undefined,
  };
}

export function adaptAcpInitializeResult(result: unknown): unknown[] {
  const adapted: unknown[] = [];
  const models = extractAcpModels(result);
  if (models.models.length > 0) {
    adapted.push({
      type: 'models',
      models: models.models,
      selectedModel: models.selectedModel,
    });
  }
  const commands = extractAcpCommands(result);
  if (commands.length > 0) adapted.push({ type: 'commands', commands });
  return adapted;
}

export function adaptAcpPromptResult(result: unknown): unknown | null {
  if (!result || typeof result !== 'object') return null;
  const obj = result as { _meta?: { quota?: unknown } };
  const quota = obj._meta?.quota;
  if (!quota || typeof quota !== 'object') return { type: 'result', stats: {} };

  const quotaObj = quota as {
    token_count?: { input_tokens?: unknown; output_tokens?: unknown };
    model_usage?: Array<{
      model?: unknown;
      token_count?: { input_tokens?: unknown; output_tokens?: unknown };
    }>;
  };
  const stats: { total_tokens?: number; models?: Record<string, { total_tokens: number }> } = {};
  const total = tokenTotal(quotaObj.token_count);
  if (total !== null) stats.total_tokens = total;

  const models: Record<string, { total_tokens: number }> = {};
  for (const entry of quotaObj.model_usage ?? []) {
    if (typeof entry.model !== 'string') continue;
    const modelTotal = tokenTotal(entry.token_count);
    if (modelTotal !== null) models[entry.model] = { total_tokens: modelTotal };
  }
  if (Object.keys(models).length > 0) stats.models = models;
  return { type: 'result', stats };
}

export function adaptAcpSessionUpdate(params: unknown): unknown[] {
  if (!params || typeof params !== 'object') return [];
  const adapted: unknown[] = [];
  const usage = adaptAcpQuotaLike(params);
  if (usage) adapted.push(usage);

  const update = (params as { update?: unknown }).update;
  if (!update || typeof update !== 'object') return adapted;
  const updateUsage = adaptAcpQuotaLike(update);
  if (updateUsage) adapted.push(updateUsage);

  const obj = update as {
    sessionUpdate?: unknown;
    content?: { type?: unknown; text?: unknown };
    toolCallId?: unknown;
    status?: unknown;
  };

  if (obj.sessionUpdate === 'agent_thought_chunk') {
    const text = obj.content?.type === 'text' && typeof obj.content.text === 'string'
      ? obj.content.text
      : '';
    if (text) adapted.push({ type: 'thinking', content: text });
    return adapted;
  }

  if (obj.sessionUpdate === 'agent_message_chunk') {
    const text = obj.content?.type === 'text' && typeof obj.content.text === 'string'
      ? obj.content.text
      : '';
    if (text) adapted.push({ type: 'message', role: 'assistant', content: text });
    return adapted;
  }

  if (obj.sessionUpdate === 'user_message_chunk') {
    const text = obj.content?.type === 'text' && typeof obj.content.text === 'string'
      ? obj.content.text
      : '';
    if (text) adapted.push({ type: 'message', role: 'user', content: text });
    return adapted;
  }

  if (obj.sessionUpdate === 'tool_call_update') {
    const name = typeof obj.toolCallId === 'string' ? obj.toolCallId : 'tool';
    const status = typeof obj.status === 'string' ? obj.status : undefined;
    adapted.push({
      type: status === 'pending' ? 'tool_use' : 'tool_result',
      name,
      status,
    });
    return adapted;
  }

  return adapted;
}

export function adaptAcpAvailableCommandsUpdate(params: unknown): unknown | null {
  const commands = extractAcpCommands(params);
  return commands.length > 0 ? { type: 'commands', commands } : null;
}

export function selectAcpPermissionOption(params: unknown, permissionMode: PermissionMode): string | null {
  if (!params || typeof params !== 'object') return null;
  const options = (params as { options?: unknown }).options;
  if (!Array.isArray(options)) return null;

  const targetKind = permissionMode === 'yolo' ? 'allow_once' : 'reject_once';
  const matching = options.find((option): option is { optionId: string } => (
    option !== null
    && typeof option === 'object'
    && (option as { kind?: unknown }).kind === targetKind
    && typeof (option as { optionId?: unknown }).optionId === 'string'
  ));
  if (matching) return matching.optionId;

  // No fallback: never auto-select an arbitrary option. In yolo mode that could
  // silently grant a persistent (`allow_always`) or opposite-intent permission the
  // user never saw. Returning null lets the caller surface the request to the UI.
  return null;
}

export function buildAcpSelectedPermissionResult(optionId: string): unknown {
  return { outcome: { outcome: 'selected', optionId } };
}

function tokenTotal(tokenCount: unknown): number | null {
  if (!tokenCount || typeof tokenCount !== 'object') return null;
  const obj = tokenCount as { input_tokens?: unknown; output_tokens?: unknown };
  const input = typeof obj.input_tokens === 'number' ? obj.input_tokens : 0;
  const output = typeof obj.output_tokens === 'number' ? obj.output_tokens : 0;
  return input || output ? input + output : null;
}

function adaptAcpQuotaLike(value: unknown): unknown | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const quota = obj.quota ?? obj.usage ?? obj.stats ?? obj._meta;
  if (!quota || typeof quota !== 'object') return null;
  const source = (quota as Record<string, unknown>).quota ?? quota;
  const adapted = adaptAcpPromptResult({ _meta: { quota: source } });
  if (adapted && typeof adapted === 'object' && Object.keys((adapted as { stats?: object }).stats ?? {}).length > 0) {
    return adapted;
  }
  return null;
}

function extractAcpModels(value: unknown): { models: ModelOption[]; selectedModel?: string } {
  if (!value || typeof value !== 'object') return { models: [] };
  const obj = value as Record<string, unknown>;
  const modelsContainer = obj.models && typeof obj.models === 'object'
    ? obj.models as Record<string, unknown>
    : obj;
  const rawModels = firstArray(
    modelsContainer.availableModels,
    modelsContainer.available_models,
    modelsContainer.models,
    obj.availableModels,
    obj.available_models,
    obj.modelCatalog,
  );
  const current = firstString(
    modelsContainer.currentModelId,
    modelsContainer.current_model_id,
    modelsContainer.selectedModel,
    modelsContainer.selected_model,
    obj.currentModelId,
    obj.selectedModel,
  );
  const models = (rawModels ?? [])
    .map(readModelOption)
    .filter((model): model is ModelOption => model !== null);
  return { models: dedupeBy(models, model => model.id), selectedModel: current ?? undefined };
}

function extractAcpCommands(value: unknown): SlashCommand[] {
  if (!value || typeof value !== 'object') return [];
  const obj = value as Record<string, unknown>;
  const rawCommands = firstArray(
    obj.commands,
    obj.availableCommands,
    obj.available_commands,
    obj.slashCommands,
    obj.slash_commands,
    obj.prompts,
  );
  const commands = (rawCommands ?? [])
    .map(readSlashCommand)
    .filter((command): command is SlashCommand => command !== null);
  return dedupeBy(commands, command => command.name);
}

function readModelOption(value: unknown): ModelOption | null {
  if (typeof value === 'string' && value.trim()) {
    const id = value.trim();
    return { id, label: humanize(id) };
  }
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const id = firstString(obj.id, obj.modelId, obj.model_id, obj.name, obj.value);
  if (!id) return null;
  return {
    id,
    label: firstString(obj.label, obj.displayName, obj.display_name, obj.name, obj.title) ?? humanize(id),
  };
}

function readSlashCommand(value: unknown): SlashCommand | null {
  if (typeof value === 'string' && value.trim()) {
    return { name: normalizeSlash(value.trim()) };
  }
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const rawName = firstString(obj.name, obj.command, obj.id, obj.title);
  if (!rawName) return null;
  return {
    name: normalizeSlash(rawName),
    description: firstString(obj.description, obj.detail, obj.help, obj.label) ?? undefined,
    kind: firstString(obj.kind, obj.source, obj.type) ?? undefined,
  };
}

function normalizeSlash(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function firstArray(...values: unknown[]): unknown[] | null {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function dedupeBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const k = key(value);
    if (seen.has(k)) continue;
    seen.add(k);
    result.push(value);
  }
  return result;
}

function humanize(id: string): string {
  if (id === 'auto') return 'Auto';
  return id
    .replace(/^models\//, '')
    .split(/[-_]/)
    .filter(Boolean)
    .map(part => /^\d+(\.\d+)?$/.test(part)
      ? part
      : part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
