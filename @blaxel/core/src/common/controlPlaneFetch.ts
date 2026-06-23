import { createPoolBackedH2Fetch } from "./h2fetch.js";
import { h2Pool } from "./h2pool.js";
import { settings } from "./settings.js";

const h2FetchByHost = new Map<string, (input: Request) => Promise<Response>>();

// Node's global fetch dispatcher only negotiates HTTP/2 by default starting
// with undici 8 (Node 26+); undici 7 (Node 24) and undici 6 (Node 22) still
// ALPN to HTTP/1.1 for fetch, verified empirically against api.blaxel.ai. On
// undici >= 8 the pooled wrapper is redundant, so we prefer the native path.
export function undiciSupportsNativeH2(undiciVersion: string | undefined): boolean {
  const major = Number(undiciVersion?.split(".")[0] ?? 0);
  return major >= 8;
}

// `process`/`process.versions` is absent on Cloudflare Workers and other
// non-Node runtimes, and `process.versions.undici` is undefined on Bun/Deno;
// all of those resolve to `false` and keep the wrapper as the fallback.
export const nativeFetchSupportsH2 =
  typeof process !== "undefined" && undiciSupportsNativeH2(process.versions?.undici);

export function shouldUseControlPlaneH2(
  url: URL,
  h2Disabled: boolean,
  proxyConfigured = false,
  nativeH2 = false,
  forceWrapper = false,
): boolean {
  if (h2Disabled || proxyConfigured) return false;
  if (url.protocol !== "https:") return false;
  // Token refresh is sequential and unauthenticated; it cannot contribute to
  // the create burst TLS storm, and device-mode refresh currently relies on the
  // native fetch path.
  if (url.pathname.endsWith("/oauth/token")) return false;
  if (!(url.hostname.endsWith("blaxel.ai") || url.hostname.endsWith("blaxel.dev"))) {
    return false;
  }
  // Native fetch already negotiates HTTP/2: skip the redundant wrapper unless
  // explicitly forced (e.g. to exercise the pooled path on a modern runtime).
  if (nativeH2 && !forceWrapper) return false;
  return true;
}

export function controlPlaneFetch(input: Request): Promise<Response> {
  const url = new URL(input.url);
  const proxyConfigured = Boolean(settings.config.proxy);
  // Global disableH2 still wins; disableControlPlaneH2 opts out of just the
  // control-plane wrapper while leaving data-plane H2 in place.
  const h2Disabled = settings.disableH2 || settings.disableControlPlaneH2;
  if (
    !shouldUseControlPlaneH2(
      url,
      h2Disabled,
      proxyConfigured,
      nativeFetchSupportsH2,
      settings.forceControlPlaneH2,
    )
  ) {
    return globalThis.fetch(input);
  }

  let h2Fetch = h2FetchByHost.get(url.hostname);
  if (!h2Fetch) {
    h2Fetch = createPoolBackedH2Fetch(h2Pool, url.hostname);
    h2FetchByHost.set(url.hostname, h2Fetch);
  }
  return h2Fetch(input);
}
