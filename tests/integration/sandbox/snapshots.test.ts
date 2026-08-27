import { SandboxInstance } from "@blaxel/core";
import { afterAll, describe, expect, it } from "vitest";
import { defaultImage, defaultLabels, defaultRegion, isSlowTestEnabled, retry, skipUnlessGenerationMk31, uniqueName } from "./helpers.js";

// A restore tears the running instance down and builds it back from the
// snapshot, so it costs a full sandbox start on top of taking the snapshot —
// past the one-minute budget of the default run.
describe.runIf(isSlowTestEnabled("RUN_SLOW_RESTORE"))("Sandbox snapshot restore", { timeout: 600000 }, () => {
  const name = uniqueName("restore");

  afterAll(async () => {
    try {
      await SandboxInstance.delete(name);
    } catch {
      // Ignore
    }
  });

  it("puts the filesystem back to the snapshot it restores", async (ctx) => {
    // Snapshots, and therefore restores, only exist on mk3.1 sandboxes.
    await skipUnlessGenerationMk31(ctx, "snapshots and restores");

    const sandbox = await SandboxInstance.create({
      name,
      image: defaultImage,
      region: defaultRegion,
      labels: defaultLabels,
    });
    await sandbox.fs.write("/blaxel/snapshotted.txt", "kept");

    const snapshot = await sandbox.snapshot("restore-point");
    expect(snapshot.id).toBeTruthy();

    // Only a ready snapshot holds the filesystem it captured.
    await retry(async () => {
      const snapshots = await sandbox.listSnapshots();
      expect(snapshots.find((s) => s.id === snapshot.id)?.status).toBe("ready");
    }, { retries: 60, delayMs: 2000 });

    // Written after the snapshot: the restore is expected to lose it.
    await sandbox.fs.write("/blaxel/after-snapshot.txt", "lost");

    const restored = await sandbox.restore(snapshot.id);
    expect(restored.name).toBe(name);
    expect(restored.snapshotId).toBe(snapshot.id);

    // The restore is asked for without waiting on the guest, so the sandbox
    // answers again only once its instance is back up.
    await retry(async () => {
      expect(await sandbox.fs.read("/blaxel/snapshotted.txt")).toBe("kept");
    }, { retries: 60, delayMs: 2000 });
    await expect(sandbox.fs.read("/blaxel/after-snapshot.txt")).rejects.toThrow();
  });
});
