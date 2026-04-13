import { Sandbox } from "../../client/types.gen.js";
import { settings } from "../../common/settings.js";
import { SandboxAction } from "../action.js";

export class SandboxNetwork extends SandboxAction {
  constructor(sandbox: Sandbox) {
    super(sandbox);
  }

  /**
   * Fetch a resource served on a sandbox port.
   * The request is proxied through the sandbox's `/port/{port}` endpoint.
   *
   * @param port - The port number inside the sandbox
   * @param path - Optional path appended after the port (default: "/")
   * @param init - Standard RequestInit options forwarded to fetch
   */
  async fetch(port: number, path = "/", init?: RequestInit): Promise<Response> {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = `${this.url}/port/${port}${normalizedPath}`;
    const headers = (this.sandbox.forceUrl ? this.sandbox.headers : undefined) ?? settings.headers;
    const initHeaders: Record<string, string> = {};
    if (init?.headers) {
      const entries =
        init.headers instanceof Headers
          ? init.headers.entries()
          : Array.isArray(init.headers)
            ? (init.headers as [string, string][]).values()
            : Object.entries(init.headers as Record<string, string>).values();
      for (const [key, value] of entries) {
        initHeaders[key] = value;
      }
    }
    return this.h2Fetch(url, {
      ...init,
      headers: {
        ...headers,
        ...initHeaders,
      },
    });
  }
}