// Delays between the status reads of a long wait (sandbox archive, image build).
//
// A wait that reads the control plane at a fixed interval sends the same load
// for its whole length, and many clients that started together read in step.
// Each wait here starts at its interval, grows it by half after every read up
// to POLL_MAX_INTERVAL_MS, and draws each delay at random between half and all
// of that value, so a few hundred waits at once stay well under the API's
// per-client request limits.

export const POLL_MAX_INTERVAL_MS = 30_000;
const POLL_GROWTH = 1.5;
// 1.5 ** 64 is far past any cap; bounding the exponent keeps the math finite
// on a wait that runs for a very long time.
const MAX_EXPONENT = 64;

/**
 * Delay in milliseconds before status read number `attempt` (1-based) of a wait.
 *
 * The delay grows from `initialMs` by half per read up to `maxMs` (or
 * `initialMs` when that is larger), and is drawn between half and all of that
 * value.
 */
export function pollDelayMs(attempt: number, initialMs: number, maxMs: number = POLL_MAX_INTERVAL_MS): number {
  if (initialMs <= 0) {
    return 0;
  }
  const ceiling = Math.max(maxMs, initialMs);
  const exponent = Math.min(Math.max(attempt - 1, 0), MAX_EXPONENT);
  const target = Math.min(initialMs * Math.pow(POLL_GROWTH, exponent), ceiling);
  return target / 2 + Math.random() * (target / 2);
}
