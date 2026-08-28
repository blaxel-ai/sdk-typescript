import { SandboxInstance } from "@blaxel/core";
import { afterAll, describe, expect, it } from "vitest";
import { defaultImage, defaultLabels, defaultRegion, isSlowTestEnabled, retry, skipUnlessGenerationMk31, uniqueName } from "./helpers.js";

// A restore tears the running instance down and builds it back from the
// snapshot, so it costs a full sandbox start on top of taking the snapshot —
// past the one-minute budget of the default run.
describe.runIf(isSlowTestEnabled("RUN_SLOW_RESTORE"))("Sandbox snapshot restore", { timeout: 180000 }, () => {
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

    // Timed step by step: a restore is only ever as slow as one of create,
    // snapshot-ready or instance-back-up, and the logs must say which.
    const startedAt = Date.now();
    const step = (label: string) =>
      console.info(`[restore] ${label} +${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

    const sandbox = await SandboxInstance.create({
      name,
      image: defaultImage,
      region: defaultRegion,
      labels: defaultLabels,
    });
    step("sandbox created");

    await sandbox.fs.write("/blaxel/snapshotted.txt", "kept");

    const snapshot = await sandbox.snapshot("restore-point");
    expect(snapshot.id).toBeTruthy();
    step("snapshot asked for");

    // Only a ready snapshot holds the filesystem it captured.
    await retry(async () => {
      const snapshots = await sandbox.listSnapshots();
      expect(snapshots.find((s) => s.id === snapshot.id)?.status).toBe("ready");
    }, { retries: 300, delayMs: 250 });
    step("snapshot ready");

    // Written after the snapshot: the restore is expected to lose it.
    await sandbox.fs.write("/blaxel/after-snapshot.txt", "lost");

    const restored = await sandbox.restore(snapshot.id);
    expect(restored.name).toBe(name);
    expect(restored.snapshotId).toBe(snapshot.id);
    step("restore asked for");

    // The restore is asked for without waiting on the guest, so the sandbox
    // answers again only once its instance is back up. A read issued while it
    // is down is held open by the edge until its own minute-long timeout, so
    // each attempt is abandoned after a few seconds instead of waiting on it.
    const deadline = Date.now() + 45000;
    let lastFailure = "never answered";
    for (;;) {
      try {
        const read = sandbox.fs.read("/blaxel/snapshotted.txt");
        const content = await Promise.race([
          read,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("read still hanging after 3s")), 3000),
          ),
        ]);
        expect(content).toBe("kept");
        break;
      } catch (err) {
        lastFailure = err instanceof Error ? err.message : String(err);
        // The record's status separates "the guest is still coming back" from
        // "the sandbox is up but the connection to it is stale".
        const status = await SandboxInstance.get(name).then((s) => s.status).catch(() => "unreadable");
        step(`sandbox not back yet (record ${status}): ${lastFailure}`);
        if (Date.now() >= deadline) {
          throw new Error(`the restored sandbox never served its snapshotted filesystem: ${lastFailure}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    step("sandbox back up on the snapshot");

    await expect(sandbox.fs.read("/blaxel/after-snapshot.txt")).rejects.toThrow();
  });
});
