import { client } from "../client/client.gen.js";
import { client as clientSandbox } from "../sandbox/client/client.gen.js";
import { initSentry } from "./sentry.js";
import { settings } from "./settings.js";

let autoloaded = false;

/**
 * Perform the observable side-effects that the SDK needs for error
 * reporting, low-latency sandbox sessions, and correct environment
 * routing:
 *
 *   - Resolve credentials (which reads `~/.blaxel/config.yaml` once and
 *     populates `BL_ENV` if the user has a dev workspace configured).
 *   - Re-apply the control-plane and sandbox clients' `baseUrl` so they
 *     target the now-env-aware endpoint.
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

  // Trigger lazy credential resolution. This may read `~/.blaxel/config.yaml`
  // and set `process.env.BL_ENV` if the user has a dev workspace configured,
  // which in turn affects `settings.baseUrl`.
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  settings.credentials;

  // Keep the clients' baseUrl in sync with the now-resolved env. Without
  // this, the module-load `client.setConfig({ baseUrl })` would be stuck on
  // the prod default for users who rely on `config.yaml` (no env vars).
  client.setConfig({ baseUrl: settings.baseUrl });
  clientSandbox.setConfig({ baseUrl: settings.baseUrl });

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
