import { createSandboxPreview, deleteSandboxPreview, getSandboxPreview, listSandboxPreviews, listSandboxPreviewTokens, Sandbox } from "../client/index.js";
import { SandboxPreview } from "./preview.js";
import { SessionCreateOptions, SessionWithToken } from "./types.js";


export class SandboxSessions {
  constructor(private sandbox: Sandbox) {}

  get sandboxName() {
    return this.sandbox.metadata?.name ?? "";
  }

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
      url: preview.spec?.url ?? "",
      token: tokenObj.value,
      expiresAt: typeof tokenObj.expiresAt === 'string' ? new Date(tokenObj.expiresAt) : tokenObj.expiresAt,
    };
  }

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

  async list() {
    const { data } = await listSandboxPreviews({
      path: {
        sandboxName: this.sandboxName,
      },
      throwOnError: true,
    });
    return await Promise.all(data.filter((preview) => preview.metadata?.name?.includes("session-")).map(async (preview) => {
      const token = await this.getToken(preview.metadata?.name ?? "");
      return {
        name: preview.metadata?.name ?? "",
        url: preview.spec?.url ?? "",
        token: token?.spec?.token ?? "",
        expiresAt: token?.spec?.expiresAt ?? new Date(),
      };
    }));
  }

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
      url: data.spec?.url ?? "",
      token: token?.spec?.token ?? "",
      expiresAt: token?.spec?.expiresAt ?? new Date(),
    };
  }

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