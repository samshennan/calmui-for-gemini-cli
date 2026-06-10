import type { ModelOption, PermissionOption, SessionInfo, SlashCommand, UsageStats } from './messages';

export function getAssistantContent(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return '';
  const event = parsed as { type?: unknown; role?: unknown; content?: unknown };
  if (event.type !== 'message' || event.role !== 'assistant') return '';
  return typeof event.content === 'string' ? event.content : '';
}

export function getUserContent(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return '';
  const event = parsed as { type?: unknown; role?: unknown; content?: unknown };
  if (event.type !== 'message' || event.role !== 'user') return '';
  return typeof event.content === 'string' ? event.content : '';
}

export function getThinkingContent(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return '';
  const event = parsed as { type?: unknown; content?: unknown; text?: unknown; thought?: unknown };
  if (event.type !== 'agent_thought_chunk' && event.type !== 'thinking') return '';
  return firstString(event.content, event.text, event.thought) ?? '';
}

export interface ParsedPermissionRequest {
  toolName: string;
  args?: string;
  options: PermissionOption[];
  messageId: number | string;
}

export function getPermissionRequest(parsed: unknown): ParsedPermissionRequest | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const event = parsed as { type?: unknown; toolName?: unknown; tool_name?: unknown; args?: unknown; options?: unknown; messageId?: unknown; id?: unknown };
  if (event.type !== 'permission_request') return null;
  const toolName = firstString(event.toolName, event.tool_name) ?? 'tool';
  const options: PermissionOption[] = [];
  if (Array.isArray(event.options)) {
    for (const opt of event.options) {
      if (opt && typeof opt === 'object') {
        const o = opt as Record<string, unknown>;
        const optionId = firstString(o.optionId, o.id, o.value);
        if (optionId) {
          options.push({
            optionId,
            label: firstString(o.label, o.displayName, o.title) ?? optionId,
            kind: firstString(o.kind, o.type) ?? undefined,
          });
        }
      }
    }
  }
  const args = typeof event.args === 'string' ? event.args
    : typeof event.args === 'object' && event.args ? JSON.stringify(event.args, null, 2)
    : undefined;
  const messageId = event.messageId ?? event.id ?? 0;
  return { toolName, args, options, messageId: typeof messageId === 'number' || typeof messageId === 'string' ? messageId : 0 };
}

export function getInitInfo(parsed: unknown): SessionInfo | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const event = parsed as { type?: unknown; model?: unknown; session_id?: unknown };
  if (event.type !== 'init') return null;
  const info: SessionInfo = {};
  if (typeof event.model === 'string' && event.model.trim()) info.resolvedModel = event.model.trim();
  if (typeof event.session_id === 'string' && event.session_id.trim()) info.sessionId = event.session_id.trim();
  return info.resolvedModel || info.sessionId ? info : null;
}

export function getErrorEvent(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const event = parsed as { type?: unknown; message?: unknown; error?: unknown; severity?: unknown };
  if (event.type !== 'error') return null;
  const raw = firstString(event.message, event.error) ?? 'Gemini CLI reported an error.';
  const severity = typeof event.severity === 'string' ? event.severity.trim().toLowerCase() : '';
  return severity && severity !== 'error' ? `[${severity}] ${raw}` : raw;
}

export function getResultUsage(parsed: unknown): UsageStats | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const event = parsed as { type?: unknown; stats?: unknown };
  if (event.type !== 'result' || !event.stats || typeof event.stats !== 'object') return null;
  const stats = event.stats as { total_tokens?: unknown; totalTokens?: unknown; models?: unknown };
  const total = typeof stats.total_tokens === 'number' ? stats.total_tokens
    : typeof stats.totalTokens === 'number' ? stats.totalTokens
    : null;
  const models: Record<string, number> = {};
  if (stats.models && typeof stats.models === 'object') {
    for (const [name, entry] of Object.entries(stats.models as Record<string, unknown>)) {
      const t = extractTokenTotal(entry);
      if (t !== null) models[name] = t;
    }
  }
  if (total === null && Object.keys(models).length === 0) return null;
  const computedTotal = total ?? Object.values(models).reduce((a, b) => a + b, 0);
  return {
    totalTokens: computedTotal,
    models: Object.keys(models).length > 0 ? models : undefined,
  };
}

export function getAvailableModels(parsed: unknown): { models: ModelOption[]; selectedModel?: string } | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const event = parsed as { type?: unknown; models?: unknown; selectedModel?: unknown };
  if (event.type !== 'models' || !Array.isArray(event.models)) return null;
  const models = event.models
    .map(readModelOption)
    .filter((model): model is ModelOption => model !== null);
  if (models.length === 0) return null;
  return {
    models,
    selectedModel: typeof event.selectedModel === 'string' && event.selectedModel.trim()
      ? event.selectedModel.trim()
      : undefined,
  };
}

export function getAvailableCommands(parsed: unknown): SlashCommand[] | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const event = parsed as { type?: unknown; commands?: unknown };
  if (event.type !== 'commands' || !Array.isArray(event.commands)) return null;
  const commands = event.commands
    .map(readSlashCommand)
    .filter((command): command is SlashCommand => command !== null);
  return commands.length > 0 ? commands : null;
}

export function extractTokenTotal(entry: unknown): number | null {
  if (entry && typeof entry === 'object') {
    const obj = entry as Record<string, unknown>;
    for (const key of ['total_tokens', 'totalTokens', 'total', 'tokens']) {
      const v = obj[key];
      if (typeof v === 'number') return v;
    }
    const prompt = typeof obj.prompt_tokens === 'number' ? obj.prompt_tokens : 0;
    const response = typeof obj.response_tokens === 'number' ? obj.response_tokens : 0;
    if (prompt || response) return prompt + response;
  }
  if (typeof entry === 'number') return entry;
  return null;
}

export function getToolActivity(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return '';
  const event = parsed as {
    type?: unknown;
    name?: unknown;
    tool_name?: unknown;
    server_name?: unknown;
    status?: unknown;
  };
  if (event.type !== 'tool_use' && event.type !== 'tool_result') return '';

  const name = firstString(event.name, event.tool_name, event.server_name) ?? 'tool';
  if (event.type === 'tool_use') return `Using ${name}`;
  const status = typeof event.status === 'string' ? `: ${event.status}` : '';
  return `Finished ${name}${status}`;
}

export function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function readModelOption(value: unknown): ModelOption | null {
  if (typeof value === 'string' && value.trim()) {
    const id = value.trim();
    return { id, label: humanizeModelId(id) };
  }
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const id = firstString(obj.id, obj.modelId, obj.name, obj.value);
  if (!id) return null;
  return {
    id,
    label: firstString(obj.label, obj.displayName, obj.name, obj.title) ?? humanizeModelId(id),
  };
}

function readSlashCommand(value: unknown): SlashCommand | null {
  if (typeof value === 'string' && value.trim()) {
    const name = normalizeCommandName(value);
    return name ? { name } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const name = normalizeCommandName(firstString(obj.name, obj.command, obj.id, obj.title));
  if (!name) return null;
  return {
    name,
    description: firstString(obj.description, obj.detail, obj.help, obj.label) ?? undefined,
    kind: firstString(obj.kind, obj.source, obj.type) ?? undefined,
  };
}

function normalizeCommandName(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function humanizeModelId(id: string): string {
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
