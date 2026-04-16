import { initSentry } from "./sentry.js";
import { settings } from "./settings.js";

let autoloaded = false;

/**
 * Perform the observable side-effects that the SDK needs for error
 * reporting and low-latency sandbox sessions:
 *
 *   - Initialize the lightweight Sentry client (registers
 *     `uncaughtExceptionMonitor` and patches `console.error` in Node).
 *   - Pre-warm the edge H2 connection pool for `settings.region`.
 *
 * These used to run at module load, but that meant `import "@blaxel/core"`
 * alone had observable side-effects. They are now deferred until the SDK
 * is first actually used — the request interceptor calls this on the
 * first HTTP request.
 */
export function ensureAutoloaded(): void {
  if (autoloaded) return;
  autoloaded = true;

  // Initialize Sentry for SDK error tracking.
  initSentry();

  // Background H2 connection warming (Node.js only)
  const isNode = typeof process !== "undefined" && process.versions != null && process.versions.node != null;
  /* eslint-disable */
  const isBrowser = typeof globalThis !== "undefined" && (globalThis as any)?.window !== undefined;

  if (isNode && !isBrowser) {
    try {
      // Pre-warm edge H2 for the configured region so the first
      // SandboxInstance.create() gets an instant session via the pool.
      // The control-plane client (api.blaxel.ai) stays on regular fetch
      // which already benefits from undici's built-in connection pooling.
      const region = settings.region;
      if (region) {
        import("./h2pool.js").then(({ h2Pool }) => {
          const edgeSuffix = settings.env === "prod" ? "bl.run" : "runv2.blaxel.dev";
          h2Pool.warm(`any.${region}.${edgeSuffix}`);
        }).catch(() => {});
      }
    } catch {
      // Silently ignore warming failures
    }
  }
}
