import { ensureAutoloaded } from "../common/lazyInit.js";
import { settings } from "../common/settings.js";

type Interceptor = (
  request: Request,
  options: Record<string, unknown>
) => Promise<Request | Response>;

// Default baseUrl baked into the generated control-plane client. Requests
// carrying this prefix came from the module-load client config, before
// `ensureAutoloaded()` had a chance to resolve the real env from
// `~/.blaxel/config.yaml`.
const DEFAULT_CONTROLPLANE_BASE_URL = "https://api.blaxel.ai/v0";

export const interceptors: Interceptor[] = [
  // Authentication interceptor
  async (request: Request, options: Record<string, unknown>) => {
    // Trigger deferred autoload side-effects (lazy credential resolution,
    // client baseUrl sync, Sentry init, H2 warming) on the first actual SDK
    // use, rather than at module-import time.
    ensureAutoloaded();
    if (options.authenticated === false) {
      return request;
    }
    await settings.authenticate();

    // If lazy env resolution just moved the effective baseUrl off the
    // module-load default (e.g. a user with `env: dev` in config.yaml but
    // no BL_ENV env var), the very first request was built against the
    // stale prod URL. Rebase it to the correct environment. Subsequent
    // requests use the updated `client.setConfig()` applied in
    // `ensureAutoloaded()`, so this branch only fires once.
    const correctBase = settings.baseUrl;
    if (
      correctBase !== DEFAULT_CONTROLPLANE_BASE_URL &&
      request.url.startsWith(DEFAULT_CONTROLPLANE_BASE_URL)
    ) {
      const newUrl =
        correctBase.replace(/\/$/, "") +
        request.url.slice(DEFAULT_CONTROLPLANE_BASE_URL.length);
      request = new Request(newUrl, request);
    }

    for (const header in settings.headers) {
      request.headers.set(header, settings.headers[header]);
    }
    return request;
  },
];
