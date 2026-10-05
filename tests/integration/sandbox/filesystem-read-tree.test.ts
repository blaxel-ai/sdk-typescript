import { FilesystemReadTreeError, SandboxInstance } from "@blaxel/core";
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
      { path: "dist/built.json", content: "{}" },
      { path: "notes.txt", content: "not selected" },
    ], root);
    await sandbox.fs.mkdir("/tmp/read-tree-empty");
    await sandbox.process.exec({
      command: `mkdir ${root}-link && ln -s ${root}/nested ${root}-link/current`,
      waitForCompletion: true,
    });
  });

  afterAll(async () => {
    await SandboxInstance.delete(name);
    expect(await waitForSandboxDeletion(name)).toBe(true);
  });

  it("reads the selected files by relative path, skipping find's default directories", async () => {
    expect(await sandbox.fs.readTree(root, { patterns: ["*.json"] })).toEqual({
      "a.json": "{\"a\":\"café 🚀\"}\n",
      "nested/b.json": "{\"b\":2}\n",
    });
    expect(await sandbox.fs.readTree("/tmp/read-tree-empty")).toEqual({});
  });

  it("replaces the default exclusions when excludeDirs is set", async () => {
    const files = await sandbox.fs.readTree(root, { patterns: ["*.json"], excludeDirs: ["node_modules"] });
    expect(Object.keys(files)).toEqual(["a.json", "dist/built.json", "nested/b.json"]);
  });

  it("rejects with MAX_FILES instead of truncating", async () => {
    const error = await sandbox.fs.readTree(root, { patterns: ["*.json"], maxFiles: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FilesystemReadTreeError);
    expect(error).toMatchObject({ code: "MAX_FILES", root });
  });

  it("fails with DISCOVERY for a missing directory and READ, with the path, for a symlink to a directory", async () => {
    await expect(sandbox.fs.readTree("/tmp/read-tree-missing")).rejects.toMatchObject({ code: "DISCOVERY" });
    await expect(sandbox.fs.readTree(`${root}-link`)).rejects.toMatchObject({ code: "READ", path: "current" });
  });
});
