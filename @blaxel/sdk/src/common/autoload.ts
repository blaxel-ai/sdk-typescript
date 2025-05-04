import { client } from "../client/client.gen.js";
import { interceptors } from "../client/interceptors.js";
import { client as clientSandbox } from "../sandbox/client/client.gen.js";
import { Config, settings } from "./settings.js";

client.setConfig({
  baseUrl: settings.baseUrl,
});

for (const interceptor of interceptors) {
  // @ts-expect-error - Interceptor is not typed
  client.interceptors.request.use(interceptor);
  // @ts-expect-error - Interceptor is not typed
  clientSandbox.interceptors.request.use(interceptor);
}

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
