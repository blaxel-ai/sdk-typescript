/**
 * HTTP/2 runtime-capability detection.
 *
 * The SDK's pooled HTTP/2 transport relies on the runtime's HTTP/2 client
 * managing connection-level flow control correctly. One runtime does not:
 *
 *   Bun < 1.3.11 never sends a connection-level WINDOW_UPDATE frame. The pooled
 *   H2 session therefore freezes after exactly 65535 cumulative body bytes (the
 *   default connection receive window that Bun never grows), and every request
 *   on that session hangs until the edge resets the streams (~330s).
 *   Fixed in Bun 1.3.11: https://bun.com/blog/bun-v1.3.11
 *
 * This module centralizes the version gate so the settings layer, the unit
 * tests, and the cross-runtime environment tests all agree on ONE definition of
 * "is this a Bun that breaks pooled H2". Keeping a single source of truth is the
 * whole point: the bug this guards against is subtle and the parse is easy to
 * get subtly wrong (see `stripPrerelease`).
 */

/** First Bun release with a working connection-level WINDOW_UPDATE. */
export const BUN_H2_FIXED_VERSION = "1.3.11" as const;

/**
 * The default HTTP/2 connection-level receive window, in bytes (2^16 - 1). This
 * is the exact number of cumulative body bytes after which a broken-Bun pooled
 * session freezes: the window opens to 65535 and, absent a WINDOW_UPDATE, never
 * reopens. Node grows it (see `establishH2`'s `setLocalWindowSize`); Bun < 1.3.11
 * does not.
 */
export const H2_DEFAULT_CONNECTION_WINDOW_BYTES = 65535 as const;

/**
 * Parse a `major.minor.patch` version, tolerating a pre-release/build suffix
 * (e.g. `1.3.11-canary.1`, `1.4.0+build`). Returns `null` when the input is
 * absent or not a recognizable semver triple.
 */
export function parseSemver(
  version: string | undefined | null,
): [number, number, number] | null {
  if (!version) return null;
  // Strip any pre-release ("-canary.1") or build ("+abc") metadata first so a
  // tagged build compares by its release numbers, then take the leading triple.
  const core = version.split("-")[0].split("+")[0].trim();
  const parts = core.split(".");
  if (parts.length === 0) return null;
  const nums = parts.slice(0, 3).map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  const [maj = 0, min = 0, patch = 0] = nums;
  return [maj, min, patch];
}

/**
 * Given a Bun version string, is this a Bun whose HTTP/2 client breaks the
 * pooled transport (Bun < 1.3.11)? A falsy/undefined version means "not Bun",
 * which returns `false`. An unparseable version is treated as broken (`true`):
 * we cannot prove it is safe, and forcing H2 off is the safe default.
 */
export function isBrokenBunVersion(version: string | undefined | null): boolean {
  if (!version) return false;
  const parsed = parseSemver(version);
  if (parsed === null) return true;
  const [maj, min, patch] = parsed;
  return maj < 1 || (maj === 1 && (min < 3 || (min === 3 && patch < 11)));
}

/**
 * The running runtime's Bun version, or `undefined` when not on Bun (Node,
 * Deno, browsers, workers). Deno also exposes `process.versions` but never sets
 * `.bun`, so this stays `undefined` there.
 */
export function detectBunVersion(): string | undefined {
  return globalThis.process?.versions?.bun;
}

/**
 * Is the CURRENT runtime a Bun that breaks the pooled H2 transport? This is the
 * predicate the settings layer uses to force H2 off.
 */
export function isBrokenBunH2Runtime(): boolean {
  return isBrokenBunVersion(detectBunVersion());
}
