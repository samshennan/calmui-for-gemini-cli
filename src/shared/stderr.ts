/**
 * Classifies a single stderr line from Gemini CLI into a user-facing warning
 * message, or returns null if the line is not a recognized pattern.
 */
export function classifyStderrLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const blockedTool = trimmed.match(/Unauthorized tool call: ['"]?([A-Za-z0-9_.-]+)['"]? is not available/i);
  if (blockedTool) {
    return `Gemini tried to call tool **${blockedTool[1]}** but it is not available in this agent's permitted tool set.`;
  }

  const recursionGuard = trimmed.match(/Skipping subagent tool ['"]?([A-Za-z0-9_.-]+)['"]? for agent ['"]?([A-Za-z0-9_.-]+)['"]? to prevent recursion/i);
  if (recursionGuard) {
    return `Recursion guard blocked Gemini from calling subagent **${recursionGuard[1]}** from **${recursionGuard[2]}**.`;
  }

  const unknownTool = trimmed.match(/Tool ['"]([A-Za-z0-9_.-]+)['"] not found\.\s*Did you mean/i);
  if (unknownTool) {
    return `Gemini tried to use unknown tool **${unknownTool[1]}**. It may retry with a different approach or get stuck.`;
  }

  return null;
}
