import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialize } from "../common/autoload.js";
import { settings } from "../common/settings.js";
import { ImageInstance } from "./image.js";

// Exercise the generated client, authentication headers and cursor helpers over HTTP.
describe("image pagination HTTP contract", () => {
  let server: Server;
  const requests: { url: URL; version: string | string[] | undefined }[] = [];
  const previousConfig = { ...settings.config };
  const previousCredentials = settings.credentials;

  beforeEach(async () => {
    requests.length = 0;
    server = createServer((request, response) => {
      const url = new URL(request.url!, "http://localhost");
      requests.push({ url, version: request.headers["blaxel-version"] });
      const cursor = url.searchParams.get("cursor");
      const tag = url.pathname.endsWith("/tags");
      const item = tag ? { name: "v2", size: 123 } : { metadata: { name: "example" }, spec: { size: 123, tagCount: 10000 } };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        data: cursor === "empty" ? [] : [item],
        meta: cursor === "end" ? {} : { total: 10000, totalIsPartial: true, hasMore: true, nextCursor: cursor ? "end" : "empty" },
      }));
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
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("lists summaries lazily and follows empty pages without fetching tags", async () => {
    const page = await ImageInstance.list({ limit: 1, q: "ex", sort: "name:asc" });
    expect(requests).toHaveLength(1);
    expect(page.data[0].spec.tagCount).toBe(10000);
    expect(page.meta.totalIsPartial).toBe(true);
    const items = await page.autoPagingToArray({ limit: 10 });
    expect(items).toHaveLength(2);
    expect(requests.map(({ url }) => url.pathname)).toEqual(["/images", "/images", "/images"]);
    expect(requests.map(({ url }) => url.searchParams.get("cursor"))).toEqual([null, "empty", "end"]);
    for (const request of requests) {
      expect(request.version).toBe("2026-09-22");
      expect(request.url.searchParams.get("q")).toBe("ex");
      expect(request.url.searchParams.get("limit")).toBe("1");
      expect(request.url.searchParams.get("sort")).toBe("name:asc");
    }
  });

  it("preserves shared-owner and tag filters on every page", async () => {
    const page = await ImageInstance.listTags("sandbox", "example", {
      limit: 1, name: "v2", sourceWorkspace: "owner", sort: "name:desc",
    });
    expect(await page.autoPagingToArray({ limit: 10 })).toHaveLength(2);
    for (const { url } of requests) {
      expect(url.pathname).toBe("/images/sandbox/example/tags");
      expect(url.searchParams.get("sourceWorkspace")).toBe("owner");
      expect(url.searchParams.get("name")).toBe("v2");
      expect(url.searchParams.get("sort")).toBe("name:desc");
    }
  });
});
