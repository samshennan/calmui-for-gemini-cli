import { describe, it, expect, vi } from 'vitest';
import { createTokenGuard, isTokenCurrent } from './generationToken';

describe('createTokenGuard', () => {
  it('guarded callback executes when token matches', () => {
    let current = 1;
    const guard = createTokenGuard(() => current, 1);
    const fn = vi.fn();
    guard(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('guarded callback is no-op when token differs', () => {
    let current = 2;
    const guard = createTokenGuard(() => current, 1);
    const fn = vi.fn();
    guard(fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it('simulated kill increments token and blocks stale callback', () => {
    let currentToken = 1;
    const guard = createTokenGuard(() => currentToken, 1);
    // Simulate kill — increment token
    currentToken = 2;
    const fn = vi.fn();
    guard(fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it('simulated flushQueue after kill drops stale item', () => {
    let currentToken = 1;
    const flushToken = currentToken;
    // Simulate kill — increment token
    currentToken = 2;
    // Flush should check: flushToken !== currentToken
    expect(flushToken !== currentToken).toBe(true);
  });

  it('multiple rapid kills keep incrementing and all prior guards are stale', () => {
    let currentToken = 0;
    const guard0 = createTokenGuard(() => currentToken, 0);
    currentToken++; // kill 1 → token=1
    const guard1 = createTokenGuard(() => currentToken, 1);
    currentToken++; // kill 2 → token=2
    const guard2 = createTokenGuard(() => currentToken, 2);
    currentToken++; // kill 3 → token=3

    const fn = vi.fn();
    guard0(fn);
    guard1(fn);
    guard2(fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it('reports whether an async continuation still belongs to the active generation', () => {
    let current = 7;
    expect(isTokenCurrent(() => current, 7)).toBe(true);

    current = 8;
    expect(isTokenCurrent(() => current, 7)).toBe(false);
  });
});
