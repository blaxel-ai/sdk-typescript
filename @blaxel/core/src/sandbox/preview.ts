import { createSandboxPreview, deleteSandboxPreview, getSandboxPreview, listSandboxPreviews, Preview, Sandbox } from "../client/index.js";

export class SandboxPreview {
  constructor(private preview: Preview) {}

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