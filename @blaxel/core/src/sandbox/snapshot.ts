import { deleteSandboxSnapshot, listSandboxSnapshots, restoreSandboxSnapshot, type Sandbox, type SandboxRestoreResponse, type SandboxSnapshot } from "../client/index.js";
import { Snapshot } from "../snapshot/index.js";

/**
 * SandboxSnapshotsResource is the sandbox's view of the workspace's snapshots: the
 * ones captured from it. A snapshot itself belongs to the workspace, so
 * deleting one here deletes it everywhere, and it stays after this sandbox is
 * deleted.
 */
export class SandboxSnapshotsResource {
  constructor(private sandbox: Sandbox) {}

  get sandboxName() {
    return this.sandbox.metadata.name;
  }

  /**
   * Capture a snapshot of the sandbox.
   *
   * @param name - Name of the snapshot, unique in the workspace. Generated
   * when omitted.
   */
  async create(name?: string): Promise<Snapshot> {
    return await Snapshot.create({
      ...(name !== undefined ? { name } : {}),
      source: { name: this.sandboxName, kind: "sandbox" },
    });
  }

  /** List the snapshots captured from this sandbox. */
  async list(): Promise<Snapshot[]> {
    const { data } = await listSandboxSnapshots({
      path: { sandboxName: this.sandboxName },
      throwOnError: true,
    });
    return data.map((snapshot: SandboxSnapshot) => new Snapshot(snapshot));
  }

  async get(snapshotName: string): Promise<Snapshot> {
    return await Snapshot.get(snapshotName);
  }

  /**
   * Delete a snapshot captured from this sandbox. The snapshot is a workspace
   * object, so it is removed for the whole workspace.
   */
  async delete(snapshotName: string): Promise<void> {
    await deleteSandboxSnapshot({
      path: { sandboxName: this.sandboxName, snapshotId: snapshotName },
      throwOnError: true,
    });
  }

  /**
   * Restore the sandbox to one of its snapshots. The sandbox keeps its name,
   * its URLs and its previews: the running instance is torn down and rebuilt
   * from the snapshot, so everything written since it was taken is lost unless
   * it was snapshotted too.
   */
  async restore(snapshotName: string): Promise<SandboxRestoreResponse> {
    const { data } = await restoreSandboxSnapshot({
      path: { sandboxName: this.sandboxName, snapshotId: snapshotName },
      throwOnError: true,
    });
    return data;
  }
}
