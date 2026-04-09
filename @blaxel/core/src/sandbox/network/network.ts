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
    const headers = this.sandbox.forceUrl ? this.sandbox.headers : settings.headers;
    return this.h2Fetch(url, {
      ...init,
      headers: {
        ...headers,
        ...init?.headers,
      },
    });
  }
}