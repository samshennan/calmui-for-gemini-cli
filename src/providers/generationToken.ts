/**
 * Creates a token-guarded version of a callback.
 * If the token has changed since capture, the callback becomes a no-op.
 */
export function createTokenGuard(
  getCurrent: () => number,
  capturedToken: number,
): (fn: () => void) => void {
  return (fn) => {
    if (!isTokenCurrent(getCurrent, capturedToken)) return;
    fn();
  };
}

export function isTokenCurrent(
  getCurrent: () => number,
  capturedToken: number,
): boolean {
  return capturedToken === getCurrent();
}
