import { SandboxInstance } from "@blaxel/core";
import { afterAll, describe, expect, it } from "vitest";
import { defaultImage, defaultLabels, defaultRegion, fetchWithRetry, isSlowTestEnabled, uniqueName, waitForSandboxDeletion } from "./helpers.js";

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

// The whole lifecycle a customer goes through: a sandbox serving an app behind
// a preview, archived and given back, with the same preview URL serving again —
// an archive keeps the record, its name and its previews, and only releases the
// compute.
describe.runIf(isSlowTestEnabled("RUN_SLOW_ARCHIVE"))("Sandbox archive lifecycle with a preview", { timeout: 1200000 }, () => {
  const name = uniqueName("archive-preview");
  const previewName = "archive-preview";

  afterAll(async () => {
    try {
      await SandboxInstance.delete(name);
    } catch {
      // Ignore
    }
  });

  it("serves the same preview before and after an archive", async () => {
    const sandbox = await SandboxInstance.create({
      name,
      image: "blaxel/nextjs:latest",
      memory: 4096,
      region: defaultRegion,
      ports: [{ target: 3000 }],
      labels: defaultLabels,
    });

    await sandbox.process.exec({
      command: "npm run dev -- --port 3000",
      workingDir: "/blaxel/app",
      waitForPorts: [3000],
    });

    const preview = await sandbox.previews.create({
      metadata: { name: previewName },
      spec: { port: 3000, public: true },
    });
    const url = preview.spec.url!;
    expect(url).toBeTruthy();
    expect((await fetchWithRetry(url)).status).toBe(200);

    await sandbox.archive();
    expect(sandbox.status).toBe("ARCHIVED");

    await sandbox.unarchive();
    expect(sandbox.status).toBe("DEPLOYED");

    // The archive holds the filesystem, not the running processes: the dev
    // server is started again from the configuration the export saved, so the
    // preview answers once it is listening again.
    const previews = await sandbox.previews.list();
    const restored = previews.find((p) => p.name === previewName);
    expect(restored?.spec?.url).toBe(url);
    expect((await fetchWithRetry(url, undefined, { retries: 40, delayMs: 3000 })).status).toBe(200);

    await SandboxInstance.delete(name);
    expect(await waitForSandboxDeletion(name, 120)).toBe(true);
  });
});
