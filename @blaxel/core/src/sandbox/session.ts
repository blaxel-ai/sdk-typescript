import { createSandboxPreview, deleteSandboxPreview, getSandboxPreview, listSandboxPreviews, listSandboxPreviewTokens, Sandbox } from "../client/index.js";
import { SandboxPreview } from "./preview.js";
import { SessionCreateOptions, SessionWithToken } from "./types.js";

/**
 * Sessions of a sandbox: short-lived, token-protected URLs of the sandbox API
 * that let a client without a Blaxel API key, such as a browser, use the
 * sandbox's filesystem and processes. Reach it through `sandbox.sessions`. A
 * session is a private preview named `session-<timestamp>` plus a preview
 * token; open it with `SandboxInstance.fromSession()`.
 *
 * @example
 * ```typescript
 * // Server side, with Blaxel credentials:
 * const session = await sandbox.sessions.createIfExpired({
 *   expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
 * });
 * // Client side, with only the session:
 * const remote = await SandboxInstance.fromSession(session);
 * await remote.fs.write("/tmp/hello.txt", "hi");
 * ```
 */
export class SandboxSessions {
  constructor(private sandbox: Sandbox) {}

  /** Name of the sandbox the sessions belong to. */
  get sandboxName() {
    return this.sandbox.metadata.name;
  }

  /**
   * Create a session: a private preview of the sandbox API and a token for it.
   *
   * @param options - `expiresAt` (default 24 hours from now) applies to both
   * the preview and the token; `requestHeaders` and `responseHeaders` are
   * added to the traffic going through the session URL (for example CORS
   * headers for a browser client).
   * @returns The session: `name`, `url`, `token` and `expiresAt`.
   *
   * @example
   * ```typescript
   * const session = await sandbox.sessions.create({
   *   responseHeaders: { "Access-Control-Allow-Origin": "https://app.example.com" },
   * });
   * ```
   */
  async create(options: SessionCreateOptions = {}): Promise<SessionWithToken> {
    const expiresAt = options.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000); // 1 day from now
    const body = {
      metadata: {
        name: "session-" + Date.now(),
      },
      spec: {
        port: 443,
        public: false,
        expires: expiresAt.toISOString(),
        requestHeaders: options.requestHeaders,
        responseHeaders: options.responseHeaders,
      },
    };
    const { data } = await createSandboxPreview({
      path: {
        sandboxName: this.sandboxName,
      },
      body,
      throwOnError: true,
    });
    const preview = new SandboxPreview(data);
    // Create a token for the preview with the given expiresAt
    const tokenObj = await preview.tokens.create(expiresAt);
    return {
      name: body.metadata.name,
      url: preview.spec.url ?? "",
      token: tokenObj.value,
      expiresAt: typeof tokenObj.expiresAt === 'string' ? new Date(tokenObj.expiresAt) : tokenObj.expiresAt,
    };
  }

  /**
   * Return the sandbox's first session, replacing it with a new one when it
   * expires within `delta`; create one when there is none.
   *
   * @param options - Options for a new session, as for `create()`.
   * @param delta - Milliseconds the session must still be valid for. Defaults to 3600000 (1 hour).
   * @returns A session valid for at least `delta`.
   */
  async createIfExpired(options: SessionCreateOptions = {}, delta: number = 1000 * 60 * 60) {
    // First, list all sessions
    const allSessions = await this.list();
    // Variable to hold our final session
    let sessionData;
    const now = new Date();
    const threshold = new Date(now.getTime() + delta);
    // If no valid session exists, create a new one
    if (allSessions.length > 0) {
      sessionData = allSessions[0]
      if (new Date(sessionData.expiresAt) < threshold) {
        await this.delete(sessionData.name);
        sessionData = await this.create(options);
      }
    } else {
      // Create a new session
      sessionData = await this.create(options);
    }
    return sessionData;
  }

  /**
   * List the sessions of the sandbox (its previews whose name contains
   * `session-`), each with its first token.
   *
   * @returns The sessions with `name`, `url`, `token` and `expiresAt`.
   */
  async list() {
    const { data } = await listSandboxPreviews({
      path: {
        sandboxName: this.sandboxName,
      },
      throwOnError: true,
    });
    if (data === null) return [];
    return await Promise.all(data.filter((preview) => preview.metadata.name?.includes("session-")).map(async (preview) => {
      const token = await this.getToken(preview.metadata.name);
      return {
        name: preview.metadata.name,
        url: preview.spec.url ?? "",
        token: token?.spec.token ?? "",
        expiresAt: token?.spec.expiresAt ?? new Date(),
      };
    }));
  }

  /**
   * Get a session by name.
   *
   * @param name - The session name (`session-<timestamp>`).
   * @returns The session `url`, `token` and `expiresAt`.
   * @throws When no session has this name (HTTP 404).
   */
  async get(name: string) {
    const { data } = await getSandboxPreview({
      path: {
        sandboxName: this.sandboxName,
        previewName: name,
      },
      throwOnError: true,
    });
    const token = await this.getToken(name);
    return {
      url: data.spec.url ?? "",
      token: token?.spec.token ?? "",
      expiresAt: token?.spec.expiresAt ?? new Date(),
    };
  }

  /**
   * Delete a session. Its URL and token stop working.
   *
   * @param name - The session name.
   * @returns The deleted preview.
   */
  async delete(name: string) {
    const { data } = await deleteSandboxPreview({
      path: {
        sandboxName: this.sandboxName,
        previewName: name,
      },
      throwOnError: true,
    });
    return data;
  }

  /**
   * Get the first token of a session.
   *
   * @param previewName - The session name.
   * @returns The token, or null when the session has none.
   */
  async getToken(previewName: string) {
    const { data } = await listSandboxPreviewTokens({
      path: {
        sandboxName: this.sandboxName,
        previewName,
      },
      throwOnError: true,
    });
    if (data.length === 0) return null;
    return data[0];
  }
}
