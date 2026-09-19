import { createSnapshot, deleteSnapshot, forkSnapshot, type ForkSnapshotData, getSnapshot, listSnapshots, type Env, type ListSnapshotsData, type SandboxForkResponse, type SandboxSnapshot, type SandboxSnapshotSource } from "../client/index.js";
import { createPaginatedList, type ListResponse } from "../common/pagination.js";

export type SnapshotListQuery = NonNullable<ListSnapshotsData["query"]>;

/** The object a snapshot is captured from. `kind` defaults to `sandbox`. */
export type SnapshotSourceConfiguration = {
  name: string;
  kind?: SandboxSnapshotSource["kind"];
};

export type SnapshotCreateConfiguration = {
  /** Name of the snapshot, unique in the workspace. Generated when omitted. */
  name?: string;
  source: SnapshotSourceConfiguration;
};

export type SnapshotForkOptions = {
  /** Resource type to create from the snapshot. Defaults to "sandbox". */
  targetType?: "sandbox" | "application";
  /** Port to expose from the created resource. */
  port?: number;
  /** Canary traffic percentage (0-100) when forking into an application. */
  traffic?: number;
  /** Custom domain for the application fork. */
  customDomain?: string;
  /** URL prefix for the application fork. */
  prefix?: string;
  /**
   * Environment variables the fork runs with, on top of the source's. A
   * variable the source already has takes this value, others are added.
   */
  envs?: Env[];
};

/** Options of `Snapshot.forkMany`: a sandbox fork without a target name. */
export type SnapshotForkManyOptions = Omit<SnapshotForkOptions, "targetType" | "traffic" | "customDomain" | "prefix">;

export const MAX_SNAPSHOT_FORK_COUNT = 100;

/**
 * A snapshot is a workspace resource: it is captured from a sandbox, but it
 * outlives it. Deleting the sandbox it came from leaves the snapshot in place,
 * with `source.deleted` set, and it still carries what a fork needs to run.
 */
export class Snapshot {
  constructor(private snapshot: SandboxSnapshot) {}

  get name() {
    return this.snapshot.name;
  }

  /** Identifier of the snapshot on the compute plane. */
  get id() {
    return this.snapshot.id;
  }

  get status() {
    return this.snapshot.status;
  }

  get workspace() {
    return this.snapshot.workspace;
  }

  get createdAt() {
    return this.snapshot.createdAt;
  }

  /** The object the snapshot was captured from, and whether it still exists. */
  get source() {
    return this.snapshot.source;
  }

  /** The configuration a fork of this snapshot runs with. */
  get spec() {
    return this.snapshot.spec;
  }

  /**
   * Capture a snapshot of a source object.
   *
   * @example
   * ```ts
   * const snapshot = await Snapshot.create({
   *   name: "my-snapshot",
   *   source: { name: "my-sandbox" },
   * });
   * ```
   */
  static async create(config: SnapshotCreateConfiguration) {
    const { data } = await createSnapshot({
      body: {
        ...(config.name !== undefined ? { name: config.name } : {}),
        source: {
          name: config.source.name,
          ...(config.source.kind !== undefined ? { kind: config.source.kind } : {}),
        },
      },
      throwOnError: true,
    });
    return new Snapshot(data);
  }

  /**
   * Fetch a snapshot by its identifier (`snapshot.id`). Names are only unique
   * within the sandbox they were captured from, so the workspace-level routes
   * take the identifier; use `sandbox.snapshots.get(name)` to address one by
   * name.
   */
  static async get(snapshotId: string) {
    const { data } = await getSnapshot({
      path: { snapshotName: snapshotId },
      throwOnError: true,
    });
    return new Snapshot(data);
  }

  /**
   * List one page of the workspace's snapshots.
   *
   * The returned page exposes `data` for the current page, `meta` for cursor
   * metadata, and `nextPage()` / `autoPagingEach()` / `autoPagingToArray()`
   * helpers. Iterate it directly with `for await` to walk every page.
   *
   * @example
   * ```ts
   * const page = await Snapshot.list({ limit: 50 });
   * for await (const snapshot of page) {
   *   console.log(snapshot.name);
   * }
   * ```
   */
  static async list(query?: SnapshotListQuery) {
    const fetchPage = async (pageQuery?: SnapshotListQuery) => {
      const { data } = await listSnapshots({
        query: pageQuery,
        throwOnError: true,
      });
      return data as unknown as ListResponse<SandboxSnapshot>;
    };
    return createPaginatedList({
      response: await fetchPage(query),
      fetchPage,
      mapItem: (snapshot: SandboxSnapshot) => new Snapshot(snapshot),
      query,
    });
  }

  /**
   * Delete a snapshot. There is one snapshot object, so this removes it for
   * the whole workspace, whether or not the sandbox it came from still exists.
   */
  static async delete(snapshotId: string) {
    const { data } = await deleteSnapshot({
      path: { snapshotName: snapshotId },
      throwOnError: true,
    });
    return data;
  }

  async delete() {
    return await Snapshot.delete(this.id);
  }

  /**
   * Create a sandbox or an application from this snapshot. This works after
   * the sandbox the snapshot was captured from has been deleted.
   *
   * @param targetName - Name of the sandbox/application to create.
   * @param options - Fork options (target type, port, traffic, ...).
   */
  async fork(targetName: string, options: SnapshotForkOptions = {}): Promise<SandboxForkResponse> {
    const { data } = await forkSnapshot({
      path: { snapshotName: this.id },
      body: {
        targetName,
        targetType: options.targetType ?? "sandbox",
        ...(options.port !== undefined ? { port: options.port } : {}),
        ...(options.traffic !== undefined ? { traffic: options.traffic } : {}),
        ...(options.customDomain !== undefined ? { customDomain: options.customDomain } : {}),
        ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
        ...(options.envs !== undefined ? { envs: options.envs } : {}),
      },
      throwOnError: true,
    });
    return data;
  }

  /**
   * Create `count` sandboxes from this snapshot in a single request
   * (`POST /snapshots/{id}/fork?count=N`). The server generates the sandbox
   * names and either returns all of them or fails as a whole: there is no
   * partial result. `count` must be between 1 and 100.
   *
   * @param count - Number of sandboxes to create.
   * @param options - Fork options shared by every sandbox (port, envs).
   */
  async forkMany(count: number, options: SnapshotForkManyOptions = {}): Promise<SandboxForkResponse[]> {
    if (!Number.isInteger(count) || count < 1 || count > MAX_SNAPSHOT_FORK_COUNT) {
      throw new Error(`Snapshot.forkMany: count must be an integer between 1 and ${MAX_SNAPSHOT_FORK_COUNT}, got ${count}`);
    }
    const { data } = await forkSnapshot({
      path: { snapshotName: this.id },
      query: { count } as unknown as ForkSnapshotData["query"],
      body: {
        targetType: "sandbox",
        ...(options.port !== undefined ? { port: options.port } : {}),
        ...(options.envs !== undefined ? { envs: options.envs } : {}),
      } as ForkSnapshotData["body"],
      throwOnError: true,
    });
    const forks = data as unknown as SandboxForkResponse[];
    if (!Array.isArray(forks) || forks.length !== count) {
      throw new Error(`Snapshot.forkMany: expected ${count} sandboxes, got ${Array.isArray(forks) ? forks.length : "a non-array response"}`);
    }
    return forks;
  }
}
