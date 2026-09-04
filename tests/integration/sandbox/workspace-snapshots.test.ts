import { SandboxInstance, Snapshot } from "@blaxel/core";
import { afterAll, describe, expect, it } from "vitest";
import { defaultImage, defaultLabels, defaultRegion, isSlowTestEnabled, retry, skipUnlessGenerationMk31, uniqueName, waitForSandboxDeletion } from "./helpers.js";

describe("Workspace snapshots", { timeout: 180000 }, () => {
  const sandboxName = uniqueName("snap-src");
  const snapshotName = uniqueName("snap");
  const forkName = uniqueName("snap-fork");

  afterAll(async () => {
    for (const cleanup of [
      () => Snapshot.delete(snapshotName),
      () => SandboxInstance.delete(sandboxName),
      () => SandboxInstance.delete(forkName),
    ]) {
      try {
        await cleanup();
      } catch {
        // Ignore
      }
    }
  });

  it("keeps a snapshot after the sandbox it was captured from is deleted", async (ctx) => {
    // Snapshots only exist on mk3.1 sandboxes.
    await skipUnlessGenerationMk31(ctx, "snapshots");

    const sandbox = await SandboxInstance.create({
      name: sandboxName,
      image: defaultImage,
      region: defaultRegion,
      labels: defaultLabels,
    });

    const snapshot = await sandbox.snapshots.create(snapshotName);
    expect(snapshot.name).toBe(snapshotName);
    expect(snapshot.source?.kind).toBe("sandbox");
    expect(snapshot.source?.name).toBe(sandboxName);

    const fromSandbox = await sandbox.snapshots.list();
    expect(fromSandbox.map((s) => s.name)).toContain(snapshotName);

    const fromWorkspace = await Snapshot.list({ limit: 200 });
    expect(await fromWorkspace.autoPagingToArray({ limit: 500 }).then((all) => all.map((s) => s.name))).toContain(snapshotName);

    // Only a ready snapshot holds the filesystem it captured, and only a ready
    // one is worth outliving its sandbox.
    await retry(async () => {
      const ready = await Snapshot.get(snapshotName);
      expect(ready.status).toBe("ready");
    }, { retries: 300, delayMs: 250 });

    await SandboxInstance.delete(sandboxName);
    await waitForSandboxDeletion(sandboxName);

    const orphan = await Snapshot.get(snapshotName);
    expect(orphan.name).toBe(snapshotName);
    expect(orphan.source?.deleted).toBe(true);
    // What a fork needs to run is on the snapshot itself, not on the source.
    expect(orphan.spec?.image).toBeTruthy();
  });

  // A fork is a full sandbox start on top of the snapshot the test above takes,
  // past the one-minute budget of the default run.
  it.runIf(isSlowTestEnabled("RUN_SLOW_SNAPSHOT_FORK"))("creates a sandbox from a snapshot whose source is gone", async () => {
    const snapshot = await Snapshot.get(snapshotName);
    expect(snapshot.source?.deleted).toBe(true);

    const fork = await snapshot.fork(forkName);
    expect(fork.name).toBe(forkName);
    expect(fork.type).toBe("sandbox");

    const forked = await SandboxInstance.get(forkName);
    expect(forked.metadata.name).toBe(forkName);
  });
});
