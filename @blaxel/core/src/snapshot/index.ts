import { createSnapshot, deleteSnapshot, forkSnapshot, getSnapshot, listSnapshots, type ListSnapshotsData, type SandboxForkResponse, type SandboxSnapshot, type SandboxSnapshotSource } from "../client/index.js";
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
};

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

  static async get(snapshotName: string) {
    const { data } = await getSnapshot({
      path: { snapshotName },
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
  static async delete(snapshotName: string) {
    const { data } = await deleteSnapshot({
      path: { snapshotName },
      throwOnError: true,
    });
    return data;
  }

  async delete() {
    return await Snapshot.delete(this.name);
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
      path: { snapshotName: this.name },
      body: {
        targetName,
        targetType: options.targetType ?? "sandbox",
        ...(options.port !== undefined ? { port: options.port } : {}),
        ...(options.traffic !== undefined ? { traffic: options.traffic } : {}),
        ...(options.customDomain !== undefined ? { customDomain: options.customDomain } : {}),
        ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
      },
      throwOnError: true,
    });
    return data;
  }
}
