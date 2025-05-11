import { createClient } from "@hey-api/client-fetch";
import { env } from "process";
import { getGlobalUniqueHash } from "../common/internal.js";
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
  constructor(protected sandbox: SandboxConfiguration) {}

  get name() {
    return this.sandbox.metadata?.name ?? "";
  }

  get fallbackUrl() {
    if (this.externalUrl != this.url) {
      return this.externalUrl;
    }
    return null;
  }

  get externalUrl() {
    return `${settings.runUrl}/${settings.workspace}/sandboxes/${this.name}`
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
    return defaultClient
  }

  get forcedUrl() {
    if (this.sandbox.forceUrl) return this.sandbox.forceUrl;
    const envVar = this.name.replace(/-/g, "_").toUpperCase();
    const envName = `BL_SANDBOX_${envVar}_URL`
    if (env[envName]) {
      return env[envName]
    }
    return null;
  }

  get url(): string {
    if (this.forcedUrl) return this.forcedUrl;
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

  websocket(path: string) {
    let ws: WebSocket | null = null;
    // Build ws:// or wss:// URL from baseUrl
    let baseUrl = this.url.replace(/^http/, 'ws');
    if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
    let params = `token=${settings.token}`
    if (this.sandbox.params) {
      params = "";
      for (const [key, value] of Object.entries(this.sandbox.params)) {
        params += `${key}=${value}&`
      }
      params = params.slice(0, -1);
    }
    const wsUrl = `${baseUrl}/ws/${path}?${params}`;

    // Use isomorphic WebSocket: browser or Node.js
    let WS: typeof WebSocket | any = undefined;
    if (typeof globalThis.WebSocket !== 'undefined') {
      WS = globalThis.WebSocket;
    } else {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        WS = require('ws');
      } catch {
        WS = undefined;
      }
    }
    if (!WS) throw new Error('WebSocket is not available in this environment');
    try {
      ws = typeof WS === 'function' ? new WS(wsUrl) : new (WS as any)(wsUrl);
    } catch (err) {
      console.error('WebSocket connection error:', err);
      throw err;
    }
    return ws;
  }
}