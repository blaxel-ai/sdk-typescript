/**
 * Helpers for invoking user-supplied callbacks from inside a streaming read
 * loop.
 *
 * A callback belongs to the caller, so it can throw for reasons that have
 * nothing to do with the stream: a `JSON.parse` on a line that is not JSON, a
 * bug in a handler, a rejected promise. Called bare, that exception escapes the
 * read loop, the loop's `catch` treats it as a transport failure, and the
 * stream ends for good while the sandbox process keeps running and producing
 * output nobody receives.
 *
 * The stream must outlive its consumer's mistakes: report the error and keep
 * reading.
 */

function report(error: unknown, onError?: (error: Error) => void): void {
  const err = error instanceof Error ? error : new Error(String(error));
  if (!onError) {
    // Same fallback the stream error path already uses: never swallow silently.
    console.error("Stream callback error:", err);
    return;
  }
  // A throwing error handler must not take the stream down either.
  try {
    onError(err);
  } catch {
    // nothing left to report to
  }
}

/**
 * Invoke a synchronous callback. If it returns a promise, a later rejection is
 * reported too rather than surfacing as an unhandled rejection.
 */
export function safeCallback<T>(
  fn: ((arg: T) => unknown) | undefined,
  arg: T,
  onError?: (error: Error) => void,
): void {
  if (!fn) return;
  try {
    const result = fn(arg);
    if (result && typeof (result as Promise<unknown>).then === "function") {
      void (result as Promise<unknown>).then(undefined, (e: unknown) => report(e, onError));
    }
  } catch (error) {
    report(error, onError);
  }
}

/**
 * Await a callback, preserving delivery order, without letting a rejection end
 * the stream.
 */
export async function safeCallbackAsync<T>(
  fn: ((arg: T) => unknown) | undefined,
  arg: T,
  onError?: (error: Error) => void,
): Promise<void> {
  if (!fn) return;
  try {
    await fn(arg);
  } catch (error) {
    report(error, onError);
  }
}
