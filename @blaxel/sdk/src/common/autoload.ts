import { client } from "../client/index.js";
import { interceptors } from "../client/interceptors.js";
import { client as clientSandbox } from "../sandbox/client/index.js";
import settings, { Config } from "./settings.js";

let withAutoload = true;

export function initialize(config: Config) {
  withAutoload = false;
  settings.setConfig(config);
  client.setConfig({
    baseUrl: settings.baseUrl,
  });
}

for (const interceptor of interceptors) {
  // @ts-expect-error - Interceptor is not typed
  client.interceptors.request.use(interceptor);
  // @ts-expect-error - Interceptor is not typed
  clientSandbox.interceptors.request.use(interceptor);
}
// telemetryManager.initialize(settings);

async function autoload() {
  if (withAutoload) {
    client.setConfig({
      baseUrl: settings.baseUrl,
    });
    await settings.authenticate();
    // await telemetryManager.setConfiguration(settings);
  }
}

const autoloadPromise = autoload();

export const onLoad = function (): Promise<void> {
  return autoloadPromise;
};

autoloadPromise.catch((err) => {
  console.error(err);
  process.exit(1);
});
