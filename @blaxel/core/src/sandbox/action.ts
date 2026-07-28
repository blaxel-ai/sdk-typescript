import { createClient, type Client } from "@hey-api/client-fetch";
import { interceptors } from "../client/interceptors.js";
import { responseInterceptors } from "../client/responseInterceptor.js";
import { createPoolBackedH2Fetch, h2RequestDirectFromPool } from "../common/h2fetch.js";
import { h2Pool } from "../common/h2pool.js";
import { getForcedUrl, getGlobalUniqueHash } from "../common/internal.js";
import { settings } from "../common/settings.js";
import { GATEWAY_ERROR_STATUSES } from "../common/transient-retry.js";
import { client as defaultClient } from "./client/client.gen.js";
import { SandboxConfiguration } from "./types.js";

const GATEWAY_STATUS_TEXT: Record<number, string> = {
  502: "Bad Gateway",
  503: "Gateway Service Unavailable",
  504: "Gateway Timeout",
};

// Pull a short, human-readable detail out of the response payload, if any.
function extractErrorDetail(data: unknown, error: unknown): string | undefined {
  const fromError =
    error && typeof error === "object" && "error" in error
      ? (error as { error?: unknown }).error
      : undefined;
  const fromData =
    data && typeof data === "object" && "error" in data
      ? (data as { error?: unknown }).error
      : undefined;
  const detail = fromError ?? fromData;
  if (detail === undefined || detail === null) return undefined;
  if (typeof detail === "string") return detail;
  if (typeof detail === "number" || typeof detail === "boolean") return String(detail);
  try {
    return JSON.stringify(detail);
  } catch {
    return undefined;
  }
}

export class ResponseError extends Error {
  /** HTTP status code of the failing response, if any. */
  readonly status?: number;
  readonly statusText?: string;
  /** Parsed response body, when the client managed to parse one. */
  readonly data: unknown;

  constructor(public response: Response, data: unknown, public error: unknown) {
    const status = response.status || undefined;
    const statusText = response.statusText || undefined;
    const detail = extractErrorDetail(data, error);
    const label = status !== undefined ? String(status) : "unknown";
    const suffix = statusText ? ` ${statusText}` : "";
    const message = `Sandbox request failed with status ${label}${suffix}${detail ? `: ${detail}` : ""}`;
    super(message);
    this.name = "ResponseError";
    this.status = status;
    this.statusText = statusText;
    this.data = data;
  }
}

/**
 * Thrown when the edge/CDN in front of the sandbox returns a gateway status
 * (502/503/504) — the request never got a usable answer from the sandbox
 * itself (it is waking from standby, the command outran the edge's ~60s
 * origin-read timeout, or the edge could not reach origin). Safe to retry on an
 * idempotent operation. Catch it with `err instanceof SandboxGatewayError` or
 * `isGatewayTimeout(err)`.
 */
export class SandboxGatewayError extends ResponseError {
  constructor(response: Response, data: unknown, error: unknown) {
    super(response, data, error);
    this.name = "SandboxGatewayError";
    const known = this.status !== undefined ? GATEWAY_STATUS_TEXT[this.status] : undefined;
    this.message = `Sandbox unreachable at the edge gateway (${this.status ?? "unknown"}${known ? ` ${known}` : ""}). The sandbox may be waking from standby or the request outran the edge timeout; retry an idempotent request or poll the sandbox.`;
  }
}

/** True when `err` is a gateway status (502/503/504) from the edge. */
export function isGatewayError(err: unknown): boolean {
  return (
    err instanceof ResponseError &&
    err.status !== undefined &&
    GATEWAY_ERROR_STATUSES.has(err.status)
  );
}

/** True when `err` is specifically an edge gateway timeout (504). */
export function isGatewayTimeout(err: unknown): boolean {
  return err instanceof ResponseError && err.status === 504;
}

export class SandboxAction {
  private _h2Client: Client | null = null;
  private _h2ClientDomain: string | null = null;

  constructor(protected sandbox: SandboxConfiguration) {}

  get name() {
    return this.sandbox.metadata.name;
  }

  get fallbackUrl() {
    if (this.externalUrl != this.url) {
      return this.externalUrl;
    }
    return null;
  }

  get externalUrl() {
    return this.sandbox.metadata.url ?? `${settings.runUrl}/${settings.workspace}/sandboxes/${this.name}`;
  }

  get internalUrl() {
    const hash = getGlobalUniqueHash(settings.workspace, "sandbox", this.name);
    return `${settings.runInternalProtocol}://bl-${settings.env}-${hash}.${settings.runInternalHostname}`
  }

  get client() {
    if (this.sandbox.forceUrl) {
      return createClient({
        baseUrl: this.sandbox.forceUrl,
        headers: this.sandbox.headers,
      })
    }

    const h2Domain = this.sandbox.h2Domain;
    if (h2Domain && !settings.disableH2) {
      if (!this._h2Client || this._h2ClientDomain !== h2Domain) {
        this._h2Client = createClient({
          fetch: createPoolBackedH2Fetch(h2Pool, h2Domain),
        });
        this._h2ClientDomain = h2Domain;
        for (const interceptor of interceptors) {
          // @ts-expect-error - Interceptor is not typed
          this._h2Client.interceptors.request.use(interceptor);
        }
        for (const interceptor of responseInterceptors) {
          this._h2Client.interceptors.response.use(interceptor);
        }
      }
      return this._h2Client;
    }

    // Invalidate cached H2 client when the sandbox no longer has an H2 domain.
    this._h2Client = null;
    this._h2ClientDomain = null;

    return defaultClient
  }

  protected withClient<T extends object>(options: T): T & { client: Client } {
    const requestOptions = { ...options } as T & { client: Client };
    Object.defineProperty(requestOptions, 'client', {
      value: this.client,
      enumerable: false,
      configurable: true,
    });
    return requestOptions;
  }

  /**
   * Routes through the H2 session when available, falling back to
   * globalThis.fetch. Uses a direct H2 path that avoids Request allocation.
   */
  protected h2Fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    const h2Domain = this.sandbox.h2Domain;
    if (h2Domain && !settings.disableH2) {
      return h2RequestDirectFromPool(h2Pool, h2Domain, input.toString(), init);
    }
    return globalThis.fetch(input, init);
  }

  get forcedUrl() {
    if (this.sandbox.forceUrl) return this.sandbox.forceUrl;
    return getForcedUrl('sandbox', this.name)
  }

  get url(): string {
    if (this.forcedUrl) {
      const url = this.forcedUrl.toString();
      return url.endsWith('/') ? url.slice(0, -1) : url;
    }
    // Uncomment and use this when agent and mcp are available in mk3
    // Update all requests made in this package to use fallbackUrl when internalUrl is not working
    // if (settings.runInternalHostname) return this.internalUrl;
    return this.externalUrl;
  }

  handleResponseError(response: Response, data: unknown, error: unknown) {
    if (!response.ok || !data) {
      if (GATEWAY_ERROR_STATUSES.has(response.status)) {
        throw new SandboxGatewayError(response, data, error);
      }
      throw new ResponseError(response, data, error);
    }
  }
}
