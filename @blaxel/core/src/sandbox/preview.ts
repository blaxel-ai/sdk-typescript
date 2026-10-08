import { createSandboxPreview, createSandboxPreviewToken, deleteSandboxPreview, deleteSandboxPreviewToken, getSandboxPreview, listSandboxPreviews, listSandboxPreviewTokens } from "../client/index.js";
import type { Preview, PreviewToken, Sandbox } from "../client/index.js";
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

export class SandboxPreviewToken {
  constructor(private previewToken: PreviewToken) {}

  get name(): string {
    return this.previewToken.metadata?.name ?? "";
  }

  get value() {
    return this.previewToken.spec.token ?? "";
  }

  get expiresAt() {
    return this.previewToken.spec.expiresAt ?? new Date();
  }

  get expired() {
    return this.previewToken.spec.expired ?? false;
  }
}

export class SandboxPreviewTokens {
  constructor(private preview: Preview) {}

  get previewName() {
    return this.preview.metadata.name;
  }

  get resourceName() {
    return this.preview.metadata.resourceName ?? "";
  }

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

export class SandboxPreview {
  tokens: SandboxPreviewTokens;

  constructor(private preview: Preview) {
    this.tokens = new SandboxPreviewTokens(this);
  }

  get name() {
    return this.preview.metadata.name;
  }

  get url(): string {
    return this.preview.spec?.url ?? "";
  }

  get metadata() {
    return this.preview.metadata;
  }

  get spec() {
    return this.preview.spec;
  }
}

export class SandboxPreviews {
  constructor(private sandbox: Sandbox) {}

  get sandboxName() {
    return this.sandbox.metadata.name;
  }

  async list() {
    const { data } = await listSandboxPreviews({
      path: {
        sandboxName: this.sandboxName,
      },
      throwOnError: true,
    }) as { response: Response; data: Preview[] };
    return data.map((preview) => new SandboxPreview(preview));
  }

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


  /** Existing previews are returned as-is; shorthand's private default applies only on creation. */
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
    console.log(`Waiting for preview deletion: ${previewName}`);
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
