import http2 from "http2";
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

// Background H2 connection warming for the API endpoint (Node.js only)
const isNode = typeof process !== "undefined" && process.versions != null && process.versions.node != null;
/* eslint-disable */
const isBrowser = typeof globalThis !== "undefined" && (globalThis as any)?.window !== undefined;

let apiH2Session: http2.ClientHttp2Session | null = null;
let apiH2WarmingPromise: Promise<http2.ClientHttp2Session | null> = Promise.resolve(null);

if (isNode && !isBrowser) {
  try {
    const apiUrl = new URL(settings.baseUrl);
    const hostname = apiUrl.hostname;
    apiH2WarmingPromise = import("./h2warm.js").then(({ establishH2 }) =>
      establishH2(hostname)
    ).then((session) => {
      apiH2Session = session;
      return session;
    }).catch(() => null);
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

export { apiH2Session, apiH2WarmingPromise };
