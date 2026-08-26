import { SandboxInstance } from "@blaxel/core";
import { afterAll, describe, expect, it } from "vitest";
import { defaultImage, defaultLabels, defaultRegion, isSlowTestEnabled, uniqueName } from "./helpers.js";

// Archiving exports the whole filesystem to the archive store and shuts the
// sandbox down; the restore writes it back over a fresh instance. Even an empty
// image takes minutes both ways, well past the one-minute budget of the default
// run, so this is opt-in.
describe.runIf(isSlowTestEnabled("RUN_SLOW_ARCHIVE"))("Sandbox archive/unarchive", { timeout: 900000 }, () => {
  const name = uniqueName("archive");

  afterAll(async () => {
    try {
      await SandboxInstance.delete(name);
    } catch {
      // Ignore
    }
  });

  it("keeps the filesystem across an archive and its restore", async () => {
    const sandbox = await SandboxInstance.create({
      name,
      image: defaultImage,
      region: defaultRegion,
      labels: defaultLabels,
    });
    await sandbox.fs.write("/blaxel/archived.txt", "kept");

    await sandbox.archive();
    expect(sandbox.status).toBe("ARCHIVED");

    await sandbox.unarchive();
    expect(sandbox.status).toBe("DEPLOYED");
    expect(await sandbox.fs.read("/blaxel/archived.txt")).toBe("kept");
  });
});
