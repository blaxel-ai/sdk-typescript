import { client } from "../client/client.gen.js";
import { interceptors } from "../client/interceptors.js";
import { responseInterceptors } from "../client/responseInterceptor.js";
import { client as clientSandbox } from "../sandbox/client/client.gen.js";
import { initSentry } from "./sentry.js";
import { Config, settings } from "./settings.js";

client.setConfig({
  baseUrl: settings.baseUrl,
});

// Register request interceptors
for (const interceptor of interceptors) {
  // @ts-expect-error - Interceptor is not typed
  client.interceptors.request.use(interceptor);
  // @ts-expect-error - Interceptor is not typed
  clientSandbox.interceptors.request.use(interceptor);
}

// Register response interceptors for authentication error handling
for (const interceptor of responseInterceptors) {
  client.interceptors.response.use(interceptor);
  clientSandbox.interceptors.response.use(interceptor);
}

// Initialize Sentry for SDK error tracking immediately when module loads
initSentry();

// Background H2 connection warming (Node.js only)
const isNode = typeof process !== "undefined" && process.versions != null && process.versions.node != null;
/* eslint-disable */
const isBrowser = typeof globalThis !== "undefined" && (globalThis as any)?.window !== undefined;

if (isNode && !isBrowser) {
  try {
    const apiHostname = new URL(settings.baseUrl).hostname;

    // Warm API + edge connections via the shared pool
    import("./h2pool.js").then(({ h2Pool }) => {
      h2Pool.warm(apiHostname);

      const region = settings.region;
      if (region) {
        h2Pool.warm(`any.${region}.bl.run`);
      }

      // Wire the pool-backed H2 fetch into the control-plane client.
      // Uses dynamic lookup so the client transparently degrades to
      // regular fetch if the pool session is unavailable.
      import("./h2fetch.js").then(({ createPoolBackedH2Fetch }) => {
        client.setConfig({
          fetch: createPoolBackedH2Fetch(h2Pool, apiHostname),
        });
      }).catch(() => {});
    }).catch(() => {});
  } catch {
    // Silently ignore warming failures
  }
}

// Allow to set custom configuration for browser environment
export function initialize(config: Config) {
  settings.setConfig(config);
  client.setConfig({
    baseUrl: settings.baseUrl,
  });
  clientSandbox.setConfig({
    baseUrl: settings.baseUrl,
  });
}

export function authenticate() {
  return settings.authenticate();
}

/**
 * Close all pooled H2 connections. Call this for explicit cleanup
 * (e.g. in test teardown or before process exit).
 */
export async function closeConnections() {
  const { h2Pool } = await import("./h2pool.js");
  h2Pool.closeAll();
}
