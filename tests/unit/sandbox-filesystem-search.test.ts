import { describe, expect, it, vi } from "vitest";
import { SandboxFileSystem } from "../../@blaxel/core/src/sandbox/filesystem/filesystem.js";

function createSearchHarness() {
  const get = vi.fn<(options: { query: Record<string, unknown> }) => Promise<unknown>>().mockResolvedValue({
    response: new Response(null, { status: 200 }),
    data: { matches: [], total: 0 },
  });
  const client = { get };
  const filesystem = Object.create(SandboxFileSystem.prototype) as SandboxFileSystem;
  Object.defineProperties(filesystem, {
    client: { get: () => client },
    url: { get: () => "https://sandbox.example" },
  });
  return { filesystem, get };
}

describe("SandboxFileSystem.search", () => {
  it.each(["mngo", "", "a&b + café?#/file"])("sends the query unchanged: %j", async (query) => {
    const { filesystem, get } = createSearchHarness();

    await expect(filesystem.search(query, "/tmp/files")).resolves.toEqual({ matches: [], total: 0 });

    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0].query).toHaveProperty("query", query);
  });

  it("preserves search options alongside the query", async () => {
    const { filesystem, get } = createSearchHarness();
    await filesystem.search("main", "/tmp/files", {
      maxResults: 7,
      patterns: ["*.ts", "*.js"],
      excludeDirs: ["node_modules", ".git"],
      excludeHidden: false,
    });

    expect(get.mock.calls[0][0].query).toEqual({
      query: "main",
      maxResults: 7,
      patterns: "*.ts,*.js",
      excludeDirs: "node_modules,.git",
      excludeHidden: false,
    });
  });
});
