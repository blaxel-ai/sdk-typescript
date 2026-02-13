import { createSandboxPreview, createSandboxPreviewToken, deleteSandboxPreview, deleteSandboxPreviewToken, getSandboxPreview, listSandboxPreviews, listSandboxPreviewTokens, Preview, PreviewToken, Sandbox } from "../client/index.js";

export class SandboxPreviewToken {
  constructor(private previewToken: PreviewToken) {}

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


  async createIfNotExists(preview: Preview) {
    try {
      const previewInstance = await this.get(preview.metadata.name);
      return previewInstance;
    } catch (e) {
      if (typeof e === "object" && e !== null && "code" in e && e.code === 404) {
        return this.create(preview);
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
