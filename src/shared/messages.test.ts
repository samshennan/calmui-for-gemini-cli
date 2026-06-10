import { describe, it, expect } from 'vitest';
import { MODEL_IDS, isValidModelId } from './messages';
import type { ModelId } from './messages';

describe('MODEL_IDS', () => {
  it('contains auto as the first entry', () => {
    expect(MODEL_IDS[0]).toBe('auto');
  });

  it('contains all 7 expected model IDs', () => {
    expect(MODEL_IDS).toHaveLength(7);
    expect(MODEL_IDS).toContain('auto');
    expect(MODEL_IDS).toContain('gemini-3.1-pro-preview');
    expect(MODEL_IDS).toContain('gemini-3-flash-preview');
    expect(MODEL_IDS).toContain('gemini-3.1-flash-lite-preview');
    expect(MODEL_IDS).toContain('gemini-2.5-pro');
    expect(MODEL_IDS).toContain('gemini-2.5-flash');
    expect(MODEL_IDS).toContain('gemini-2.5-flash-lite');
  });
});

describe('isValidModelId', () => {
  it('returns true for every known model ID', () => {
    for (const id of MODEL_IDS) {
      expect(isValidModelId(id)).toBe(true);
    }
  });

  it('returns false for unknown model strings', () => {
    expect(isValidModelId('gpt-4')).toBe(false);
    expect(isValidModelId('')).toBe(false);
    expect(isValidModelId('gemini-2.0-flash')).toBe(false);
    expect(isValidModelId('AUTO')).toBe(false); // case-sensitive
  });

  it('narrows the type to ModelId', () => {
    const value: string = 'auto';
    if (isValidModelId(value)) {
      // TypeScript should allow this assignment without error
      const _model: ModelId = value;
      expect(_model).toBe('auto');
    }
  });
});
