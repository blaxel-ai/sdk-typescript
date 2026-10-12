import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialize } from "../common/autoload.js";
import { settings } from "../common/settings.js";
import { getModelMetadata } from "./index.js";

// Exercise getModelMetadata through the real generated client over HTTP so the
// distinction between a genuine 404 ("model does not exist") and other
// failures (auth, 5xx, transport) is validated end to end.
describe("getModelMetadata", () => {
  let server: Server;
  let status = 200;
  let body = "";
  const previousConfig = { ...settings.config };
  const previousCredentials = settings.credentials;

  beforeEach(async () => {
    server = createServer((_request, response) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server");
    initialize({ apiKey: "test-key", workspace: "test", disableH2: true });
    const { ensureAutoloaded } = await import("../common/lazyInit.js");
    ensureAutoloaded();
    const { client } = await import("../client/client.gen.js");
    client.setConfig({ baseUrl: `http://127.0.0.1:${address.port}`, fetch });
  });

  afterEach(async () => {
    settings.config = previousConfig;
    settings.credentials = previousCredentials;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  it("returns metadata when the model exists", async () => {
    status = 200;
    body = JSON.stringify({
      metadata: { name: "sandbox-openai" },
      spec: { runtime: { type: "openai" } },
    });
    const model = await getModelMetadata("sandbox-openai");
    expect(model?.metadata.name).toBe("sandbox-openai");
  });

  it("returns null only when the model genuinely does not exist (404)", async () => {
    status = 404;
    body = JSON.stringify({ code: 404, error: "Not found", message: "Model does not exist" });
    const model = await getModelMetadata("missing-model");
    expect(model).toBeNull();
  });

  it("throws instead of masking a server error as not found (500)", async () => {
    status = 500;
    body = JSON.stringify({ code: 500, error: "Internal", message: "boom" });
    await expect(getModelMetadata("sandbox-openai")).rejects.toThrow(
      /Failed to fetch model sandbox-openai/
    );
    await expect(getModelMetadata("sandbox-openai")).rejects.toThrow(/500/);
  });

  it("throws instead of masking an auth failure as not found (401)", async () => {
    status = 401;
    body = JSON.stringify({ code: 401, error: "Unauthorized" });
    await expect(getModelMetadata("sandbox-openai")).rejects.toThrow(
      /Failed to fetch model sandbox-openai/
    );
  });
});
