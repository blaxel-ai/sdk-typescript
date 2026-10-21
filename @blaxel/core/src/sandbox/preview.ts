import { createSandboxPreview, createSandboxPreviewToken, deleteSandboxPreview, deleteSandboxPreviewToken, getSandboxPreview, listSandboxPreviews, listSandboxPreviewTokens } from "../client/index.js";
import type { Preview, PreviewToken, Sandbox } from "../client/index.js";
import { logger } from "../common/logger.js";
import type { SandboxPreviewCreateConfiguration } from "./types.js";

function isShorthand(preview: Preview | SandboxPreviewCreateConfiguration): preview is SandboxPreviewCreateConfiguration {
  return !("metadata" in preview || "spec" in preview);
}

function normalizePreview(preview: Preview | SandboxPreviewCreateConfiguration): Preview {
  if (!isShorthand(preview)) return preview;
  if (!Number.isInteger(preview.port) || preview.port < 1 || preview.port > 65535) {
    throw new RangeError("Preview port must be an integer between 1 and 65535");
  }
  if (preview.name !== undefined && (typeof preview.name !== "string" || preview.name.length === 0)) {
    throw new RangeError("Preview name must be a nonempty string");
  }
  if (preview.public !== undefined && typeof preview.public !== "boolean") {
    throw new RangeError("Preview public must be a boolean");
  }
  return {
    metadata: { name: preview.name ?? `preview-${preview.port}` },
    spec: { port: preview.port, public: preview.public ?? false },
  };
}

// Explicit HTTP status takes precedence over a legacy numeric service code.
function httpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const fields = error as Record<string, unknown>;
  const response = fields.response;
  const responseStatus = typeof response === "object" && response !== null && "status" in response
    ? response.status : undefined;
  for (const status of [fields.status, fields.statusCode, responseStatus, fields.code]) {
    if (typeof status === "number") return status;
  }
  return undefined;
}

/** An access token for a private preview. */
export class SandboxPreviewToken {
  constructor(private previewToken: PreviewToken) {}

  /** Token name (`token-<timestamp>` when created by the SDK); pass it to `tokens.delete()`. */
  get name(): string {
    return this.previewToken.metadata?.name ?? "";
  }

  /**
   * The token. Send it in the `X-Blaxel-Preview-Token` header, or once as the
   * `bl_preview_token` query parameter in a browser, which then keeps it in a cookie.
   */
  get value() {
    return this.previewToken.spec.token ?? "";
  }

  /** When the token expires, as returned by the API (an ISO 8601 string). */
  get expiresAt() {
    return this.previewToken.spec.expiresAt ?? new Date();
  }

  /** Whether the token has expired. */
  get expired() {
    return this.previewToken.spec.expired ?? false;
  }
}

/**
 * Access tokens of a private preview. Reach it through `preview.tokens`.
 * Public previews need no token.
 *
 * @example
 * ```typescript
 * const preview = await sandbox.previews.create({ port: 3000 });
 * const token = await preview.tokens.create(new Date(Date.now() + 60 * 60 * 1000));
 * const res = await fetch(preview.url, { headers: { "X-Blaxel-Preview-Token": token.value } });
 * ```
 */
export class SandboxPreviewTokens {
  constructor(private preview: Preview) {}

  /** Name of the preview the tokens open. */
  get previewName() {
    return this.preview.metadata.name;
  }

  /** Name of the sandbox the preview belongs to. */
  get resourceName() {
    return this.preview.metadata.resourceName ?? "";
  }

  /**
   * Create a token for the preview.
   *
   * @param expiresAt - When the token stops working.
   * @returns The new token; read it from `value`.
   */
  async create(expiresAt: Date) {
    const { data } = await createSandboxPreviewToken({
      path: {
        sandboxName: this.resourceName,
        previewName: this.previewName,
      },
      body: {
        metadata: {
          name: "token-" + Date.now(),
        },
        spec: {
          expiresAt: expiresAt.toISOString(),
        },
      },
      throwOnError: true,
    });
    return new SandboxPreviewToken(data);
  }

  /**
   * Reuse the latest token within the requested expiry ceiling, or mint one.
   * minValidity is in milliseconds. Concurrent callers may create separate tokens.
   *
   * @param expiresAt - Latest acceptable expiry, also used for a new token. Defaults to 24 hours from now.
   * @param minValidity - Milliseconds a reused token must still be valid for. Defaults to 3600000 (1 hour).
   * @returns A token valid for at least `minValidity`.
   * @throws RangeError when `expiresAt` is not at least `minValidity` in the future, and an Error for a public preview.
   */
  async createIfExpired(expiresAt?: Date, minValidity: number = 3_600_000): Promise<SandboxPreviewToken> {
    const now = Date.now();
    if (!Number.isFinite(minValidity) || minValidity < 0) {
      throw new RangeError("minValidity must be finite and non-negative");
    }
    const requestedExpiry = expiresAt ?? new Date(now + 86_400_000);
    const ceiling = requestedExpiry instanceof Date ? requestedExpiry.getTime() : NaN;
    if (!Number.isFinite(ceiling) || ceiling <= now || ceiling < now + minValidity) {
      throw new RangeError("expiresAt must be a valid future date at least minValidity from now");
    }
    if (this.preview.spec?.public === true) {
      throw new Error("Cannot create or reuse a token for a public preview");
    }
    const { data } = await listSandboxPreviewTokens({
      path: {
        sandboxName: this.resourceName,
        previewName: this.previewName,
      },
      throwOnError: true,
    });
    if (!Array.isArray(data)) throw new Error("Failed to list preview tokens");

    let selected: PreviewToken | undefined;
    let latestExpiry = -Infinity;
    for (const token of data) {
      const spec = token?.spec;
      if (!spec || typeof spec.token !== "string" || spec.token.length === 0 || spec.expired === true ||
          typeof spec.expiresAt !== "string") continue;
      const expiry = Date.parse(spec.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= now || expiry < now + minValidity || expiry > ceiling) continue;
      if (expiry > latestExpiry) {
        selected = token;
        latestExpiry = expiry;
      }
    }
    return selected ? new SandboxPreviewToken(selected) : this.create(requestedExpiry);
  }

  /**
   * List the tokens of the preview.
   *
   * @returns The tokens.
   */
  async list() {
    const { data } = await listSandboxPreviewTokens({
      path: {
        sandboxName: this.resourceName,
        previewName: this.previewName,
      },
      throwOnError: true,
    }) as { response: Response; data: PreviewToken[] };
    return data.map((token) => new SandboxPreviewToken(token));
  }

  /**
   * Delete a token so it no longer opens the preview.
   *
   * @param tokenName - The token's `name` (not its `value`).
   * @returns The deleted token.
   */
  async delete(tokenName: string) {
    const { data } = await deleteSandboxPreviewToken({
      path: {
        sandboxName: this.resourceName,
        previewName: this.previewName,
        tokenName,
      },
      throwOnError: true,
    });
    return data;
  }
}

/** A preview: a URL that serves one port of a sandbox. */
export class SandboxPreview {
  /** Access tokens of the preview, needed when it is private. */
  tokens: SandboxPreviewTokens;

  constructor(private preview: Preview) {
    this.tokens = new SandboxPreviewTokens(this);
  }

  /** Preview name, unique within the sandbox. */
  get name() {
    return this.preview.metadata.name;
  }

  /** URL of the preview. A private preview answers HTTP 401 without a token. */
  get url(): string {
    return this.preview.spec?.url ?? "";
  }

  /** Preview metadata (name, sandbox name, timestamps). */
  get metadata() {
    return this.preview.metadata;
  }

  /** Preview settings: `port`, `public`, `url`, custom domain and prefix, request and response headers, `ttl` and `expires`. */
  get spec() {
    return this.preview.spec;
  }
}

/**
 * Previews of a sandbox: URLs that serve a port of the sandbox over HTTPS,
 * for example a dev server. Reach it through `sandbox.previews`. A public
 * preview is open to anyone; a private one needs a token from
 * `preview.tokens`.
 *
 * @example
 * ```typescript
 * await sandbox.process.exec({ command: "npm run dev", name: "dev", waitForPorts: [3000] });
 * const preview = await sandbox.previews.createIfNotExists({ port: 3000, public: true });
 * console.log(preview.url);
 * ```
 */
export class SandboxPreviews {
  constructor(private sandbox: Sandbox) {}

  /** Name of the sandbox the previews belong to. */
  get sandboxName() {
    return this.sandbox.metadata.name;
  }

  /**
   * List the previews of the sandbox.
   *
   * @returns The previews.
   */
  async list() {
    const { data } = await listSandboxPreviews({
      path: {
        sandboxName: this.sandboxName,
      },
      throwOnError: true,
    }) as { response: Response; data: Preview[] };
    return data.map((preview) => new SandboxPreview(preview));
  }

  /**
   * Create a preview for a port of the sandbox.
   *
   * @param preview - Either the shorthand `{ port, name?, public? }`, where
   * `name` defaults to `preview-<port>` and `public` to false, or a full
   * preview (`{ metadata: { name }, spec: { port, public, customDomain,
   * prefixUrl, requestHeaders, responseHeaders, ttl } }`).
   * @param force - Replace previews that conflict on the same custom domain prefix URL.
   * @returns The preview, with its `url`.
   * @throws When a preview with the same name exists (HTTP 409); use `createIfNotExists()` to reuse it.
   *
   * @example
   * ```typescript
   * const preview = await sandbox.previews.create({ port: 3000, public: true });
   * ```
   */
  async create(preview: Preview | SandboxPreviewCreateConfiguration, force?: boolean): Promise<SandboxPreview> {
    const normalized = normalizePreview(preview);
    const query: Record<string, string> = {}
    if (force) {
      query['force'] = 'true'
    }
    const { data } = await createSandboxPreview({
      path: {
        sandboxName: this.sandboxName,
      },
      query,
      body: normalized,
      throwOnError: true,
    });
    return new SandboxPreview(data);
  }


  /**
   * Return the preview with this name, or create it. Existing previews are
   * returned as-is; shorthand's private default applies only on creation.
   *
   * @param preview - Shorthand `{ port, name?, public? }` (name defaults to `preview-<port>`) or a full preview, as for `create()`.
   * @param force - Passed to `create()` when the preview is created.
   * @returns The existing or new preview.
   *
   * @example
   * ```typescript
   * const preview = await sandbox.previews.createIfNotExists({ port: 3000 });
   * ```
   */
  async createIfNotExists(preview: Preview | SandboxPreviewCreateConfiguration, force?: boolean): Promise<SandboxPreview> {
    if (isShorthand(preview)) {
      const normalized = normalizePreview(preview);
      try {
        return await this.get(normalized.metadata.name);
      } catch (error) {
        if (httpStatus(error) !== 404) throw error;
      }
      try {
        return await this.create(normalized, force);
      } catch (error) {
        if (httpStatus(error) !== 409) throw error;
        return this.get(normalized.metadata.name);
      }
    }
    try {
      const previewInstance = await this.get(preview.metadata.name);
      return previewInstance;
    } catch (e) {
      if (typeof e === "object" && e !== null && "code" in e && e.code === 404) {
        return this.create(preview, force);
      }
      throw e;
    }
  }

  /**
   * Get a preview by name.
   *
   * @param previewName - The preview name, such as `preview-3000`.
   * @returns The preview.
   * @throws When no preview has this name (HTTP 404).
   */
  async get(previewName: string) {
    const { data } = await getSandboxPreview({
      path: {
        sandboxName: this.sandboxName,
        previewName,
      },
      throwOnError: true,
    });
    return new SandboxPreview(data);
  }

  /**
   * Delete a preview. Waits up to 10 seconds for the deletion to finish.
   *
   * @param previewName - The preview name.
   * @returns The deleted preview.
   * @throws When the preview is still being deleted after 10 seconds.
   */
  async delete(previewName: string) {
    const { data } = await deleteSandboxPreview({
      path: {
        sandboxName: this.sandboxName,
        previewName,
      },
      throwOnError: true,
    });

    if (data.status === 'DELETING') {
      await this.waitForDeletion(previewName);
    }

    return data;
  }

  private async waitForDeletion(previewName: string, timeoutMs: number = 10000): Promise<void> {
    logger.debug(`Waiting for preview deletion: ${previewName}`);
    const pollInterval = 500; // Poll every 500ms
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {

      const {response} = await getSandboxPreview({
        path: {
          sandboxName: this.sandboxName,
          previewName,
        },
      });
      if (response.status === 404) {
        return;
      }
      // Preview still exists, wait and retry
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
    // Timeout reached, but deletion was initiated
    throw new Error(`Preview deletion timeout: ${previewName} is still in DELETING state after ${timeoutMs}ms`);
  }

}
