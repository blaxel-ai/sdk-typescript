import { ensureAutoloaded } from "../common/lazyInit.js";
import { settings } from "../common/settings.js";

type Interceptor = (
  request: Request,
  options: Record<string, unknown>
) => Promise<Request | Response>;

export const interceptors: Interceptor[] = [
  // Authentication interceptor
  async (request: Request, options: Record<string, unknown>) => {
    // Trigger deferred autoload side-effects (Sentry init, H2 warming) on
    // the first actual SDK use, rather than at module-import time.
    ensureAutoloaded();
    if (options.authenticated === false) {
      return request;
    }
    await settings.authenticate();
    for (const header in settings.headers) {
      request.headers.set(header, settings.headers[header]);
    }
    return request;
  },
];
