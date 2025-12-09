/* eslint-disable */

// Browser/Edge-compatible exports for Sentry
// In browser/edge environments, @sentry/node is not available
// All functions are no-ops

/**
 * Initialize Sentry - no-op in browser/edge environments.
 */
export function initSentry(): void {
  // No-op in browser/edge environments
}

/**
 * Flush pending Sentry events - no-op in browser/edge environments.
 */
export async function flushSentry(_timeout = 2000): Promise<void> {
  // No-op in browser/edge environments
}

/**
 * Check if Sentry is initialized - always returns false in browser/edge environments.
 */
export function isSentryInitialized(): boolean {
  return false;
}
