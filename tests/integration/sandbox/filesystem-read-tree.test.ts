import { SandboxInstance } from "@blaxel/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultImage, defaultLabels, defaultRegion, uniqueName, waitForSandboxDeletion } from "./helpers.js";

describe("Sandbox filesystem readTree", () => {
  const name = uniqueName("read-tree");
  const root = "/tmp/read-tree";
  let sandbox: SandboxInstance;

  beforeAll(async () => {
    sandbox = await SandboxInstance.create({
      name, image: defaultImage, region: defaultRegion, labels: defaultLabels, ttl: "1h",
    });
    await sandbox.fs.writeTree([
      { path: "a.json", content: "{\"a\":\"café 🚀\"}\n" },
      { path: "nested/b.json", content: "{\"b\":2}\n" },
      { path: "node_modules/skipped.json", content: "{}" },
      { path: "notes.txt", content: "not selected" },
    ], root);
    await sandbox.fs.mkdir("/tmp/read-tree-empty");
  });

  afterAll(async () => {
    await SandboxInstance.delete(name);
    expect(await waitForSandboxDeletion(name)).toBe(true);
  });

  it("reads the selected files by relative path in one request", async () => {
    expect(await sandbox.fs.readTree(root, { patterns: ["*.json"], excludeDirs: ["node_modules"] })).toEqual({
      "a.json": "{\"a\":\"café 🚀\"}\n",
      "nested/b.json": "{\"b\":2}\n",
    });
    expect(await sandbox.fs.readTree("/tmp/read-tree-empty")).toEqual({});
  });

  it("excludes nothing by default", async () => {
    expect(Object.keys(await sandbox.fs.readTree(root))).toEqual(["a.json", "nested/b.json", "node_modules/skipped.json", "notes.txt"]);
  });

  it("rejects instead of truncating when more than maxFiles match", async () => {
    await expect(sandbox.fs.readTree(root, { maxFiles: 1 })).rejects.toMatchObject({ status: 422 });
    await expect(sandbox.fs.readTree("/tmp/read-tree-missing")).rejects.toBeDefined();
  });
});
