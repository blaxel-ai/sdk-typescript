import { createSandboxPreview, createSandboxPreviewToken, deleteSandboxPreview, deleteSandboxPreviewToken, getSandboxPreview, listSandboxPreviews, listSandboxPreviewTokens, Preview, PreviewToken, Sandbox } from "../client/index.js";

export class SandboxPreviewToken {
  constructor(private previewToken: PreviewToken) {}

  get value() {
    return this.previewToken.spec?.token ?? "";
  }

  get expiresAt() {
    return this.previewToken.spec?.expiresAt ?? new Date();
  }
}

export class SandboxPreviewTokens {
  constructor(private preview: Preview) {}

  get previewName() {
    return this.preview.metadata?.name ?? "";
  }

  get resourceName() {
    return this.preview.metadata?.resourceName ?? "";
  }

  async create(expiresAt: Date) {
    const { data } = await createSandboxPreviewToken({
      path: {
        sandboxName: this.resourceName,
        previewName: this.previewName,
      },
      body: {
        spec: {
          expiresAt: expiresAt.toISOString(),
        },
      },
      throwOnError: true,
    });
    return new SandboxPreviewToken(data);
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
    return this.preview.metadata?.name ?? "";
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
    return this.sandbox.metadata?.name ?? "";
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

  async create(preview: Preview) {
    const { data } = await createSandboxPreview({
      path: {
        sandboxName: this.sandboxName,
      },
      body: preview,
      throwOnError: true,
    });
    return new SandboxPreview(data);
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
    return data;
  }
}