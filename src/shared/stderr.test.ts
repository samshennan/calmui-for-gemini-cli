import { describe, it, expect } from 'vitest';
import { classifyStderrLine } from './stderr';

describe('classifyStderrLine', () => {
  it('returns null for empty/whitespace lines', () => {
    expect(classifyStderrLine('')).toBeNull();
    expect(classifyStderrLine('   ')).toBeNull();
  });

  it('returns null for unrecognized stderr lines', () => {
    expect(classifyStderrLine('INFO: Loading config...')).toBeNull();
    expect(classifyStderrLine('some random debug output')).toBeNull();
  });

  describe('unauthorized tool call', () => {
    it('matches "Unauthorized tool call: X is not available"', () => {
      const result = classifyStderrLine(
        'Unauthorized tool call: "read_file" is not available in the current context',
      );
      expect(result).toBe(
        'Gemini tried to call tool **read_file** but it is not available in this agent\'s permitted tool set.',
      );
    });

    it('matches without quotes around tool name', () => {
      const result = classifyStderrLine(
        'Unauthorized tool call: write_file is not available here',
      );
      expect(result).toBe(
        'Gemini tried to call tool **write_file** but it is not available in this agent\'s permitted tool set.',
      );
    });
  });

  describe('recursion guard', () => {
    it('matches subagent recursion pattern', () => {
      const result = classifyStderrLine(
        'Skipping subagent tool "coder" for agent "planner" to prevent recursion',
      );
      expect(result).toBe(
        'Recursion guard blocked Gemini from calling subagent **coder** from **planner**.',
      );
    });
  });

  describe('unknown tool', () => {
    it('matches "Tool X not found. Did you mean"', () => {
      const result = classifyStderrLine(
        'Tool "search_web" not found. Did you mean "web_search"?',
      );
      expect(result).toBe(
        'Gemini tried to use unknown tool **search_web**. It may retry with a different approach or get stuck.',
      );
    });
  });
});
