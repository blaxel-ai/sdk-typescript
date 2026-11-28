import { env } from "../common/env.js";

export class Credentials {
  async authenticate() {}

  /**
   * Mark the cached token for renewal so the next authenticate() fetches a
   * fresh one. Called when a server rejects the token (HTTP 401) with the
   * token it rejected. No-op for credentials that hold no renewable token.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  invalidate(_rejectedToken?: string): void {}

  /**
   * Record that a server accepted the token. Resets any renewal backoff that
   * invalidate() built up. No-op for credentials without one.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  accepted(_acceptedToken?: string): void {}

  get workspace() {
    return env.BL_WORKSPACE || "";
  }

  get authorization() {
    return "";
  }

  get token() {
    return "";
  }
}

/**
 * Marker returned by `authentication()` when no usable Blaxel credentials were
 * resolved (no env vars, no matching config workspace). Construction is
 * side-effect free so importing `@blaxel/core` never fails; the actionable
 * error is raised when an authenticated request is actually attempted
 * (see `Settings.assertCredentials`).
 */
export class MissingCredentials extends Credentials {}
