import { client } from "../client/client.gen.js";
import { interceptors } from "../client/interceptors.js";
import { responseInterceptors } from "../client/responseInterceptor.js";
import { client as clientSandbox } from "../sandbox/client/client.gen.js";
import { Config, settings } from "./settings.js";

export { ensureAutoloaded } from "./lazyInit.js";

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

/**
 * Configure the SDK programmatically at runtime, instead of relying on
 * environment variables or config files.
 *
 * You do not need to call {@link authenticate} yourself: the SDK
 * transparently authenticates (and refreshes tokens when needed) on every
 * request. Only call `authenticate()` directly if you want to fail fast on
 * invalid credentials before making any API call.
 *
 * @example
 * // With an API key
 * initialize({ workspace: 'my-workspace', apiKey: 'bl_...' });
 *
 * @example
 * // With client credentials (object form)
 * initialize({
 *   workspace: 'my-workspace',
 *   clientCredentials: { clientId: '...', clientSecret: '...' },
 * });
 *
 * @example
 * // With client credentials (pre-encoded Base64 string)
 * initialize({
 *   workspace: 'my-workspace',
 *   clientCredentials: 'base64-encoded-string',
 * });
 */
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
