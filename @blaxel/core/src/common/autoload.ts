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

// Allow to set custom configuration for browser environment
export function initialize(config: Config) {
  settings.setConfig(config);
  client.setConfig({
    baseUrl: settings.baseUrl,
  });
}

export function authenticate() {
  return settings.authenticate();
}
