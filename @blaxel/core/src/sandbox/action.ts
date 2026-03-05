import { createClient, type Client } from "@hey-api/client-fetch";
import { responseInterceptors } from "../client/responseInterceptor.js";
import { createH2Fetch, h2RequestDirect } from "../common/h2fetch.js";
import { getForcedUrl, getGlobalUniqueHash } from "../common/internal.js";
import { settings } from "../common/settings.js";
import { client as defaultClient } from "./client/client.gen.js";
import { SandboxConfiguration } from "./types.js";

export class ResponseError extends Error {
  constructor(public response: Response, public data: unknown, public error: unknown) {
    let dataError: Record<string, unknown> = {}
    if (data && typeof data === 'object' && 'error' in data) {
      dataError = data;
    }
    if (error && typeof error === 'object' && 'error' in error) {
      dataError['error'] = error.error ;
    }
    if (response.status) {
      dataError['status'] = response.status;
    }
    if (response.statusText) {
      dataError['statusText'] = response.statusText;
    }
    super(JSON.stringify(dataError));
  }
}

export class SandboxAction {
  private _h2Client: Client | null = null;

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

    const session = this.sandbox.h2Session;
    if (session && !session.closed && !session.destroyed) {
      if (!this._h2Client) {
        // Auth is already resolved by create(). Pre-bake headers to skip
        // the async interceptor on every request.
        this._h2Client = createClient({
          fetch: createH2Fetch(session),
          headers: settings.headers,
        });
        for (const interceptor of responseInterceptors) {
          this._h2Client.interceptors.response.use(interceptor);
        }
      }
      return this._h2Client;
    }

    return defaultClient
  }

  /**
   * Routes through the H2 session when available, falling back to
   * globalThis.fetch. Uses a direct H2 path that avoids Request allocation.
   */
  protected h2Fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    const session = this.sandbox.h2Session;
    if (session && !session.closed && !session.destroyed) {
      return h2RequestDirect(session, input.toString(), init);
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
      throw new ResponseError(response, data, error);
    }
  }
}
