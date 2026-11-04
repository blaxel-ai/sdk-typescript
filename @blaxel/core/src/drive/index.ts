import { v4 as uuidv4 } from "uuid";
import { createDrive, deleteDrive, getDrive, listDrives, updateDrive, type Drive, type DrivePermission, type ListDrivesData } from "../client/index.js";
import { createPaginatedList } from "../common/pagination.js";
import { settings } from "../common/settings.js";

export type DriveListQuery = NonNullable<ListDrivesData["query"]>;

/** Shorthand configuration of `DriveInstance.create()` and `update()`. Every field is optional. */
export type DriveCreateConfiguration = {
  /**
   * Drive name, unique in the workspace: lowercase letters, digits and
   * hyphens, at most 49 characters. Defaults to `drive-<8 hex characters>`.
   * Immutable.
   */
  name?: string;
  /** Human-readable name, at most 63 characters. Defaults to the name. */
  displayName?: string;
  /** Labels to organize and filter drives. */
  labels?: Record<string, string>;
  /** @deprecated Drives have no size limit: the control plane ignores this. */
  size?: number; // Size in GB
  /**
   * Region, such as `"us-pdx-1"` or `"eu-lon-1"`. Defaults to the
   * `BL_REGION` environment variable. Must match the region of the sandboxes
   * that mount the drive. Immutable.
   */
  region?: string;
  /**
   * Which workloads may access the drive, at most 3 entries; empty means
   * every workload in the workspace. Each entry has `labels` the workload
   * must all carry, a `mode` (`"read"` or `"read-write"`) and an optional
   * subfolder `path` (default `/`). The first matching entry grants access.
   */
  permissions?: Array<DrivePermission>;
};

/**
 * A drive: a distributed filesystem that several sandboxes can mount at the
 * same time, read-write, including while they run. Its data outlives the
 * sandboxes. Mount it with `sandbox.drives.mount()`, or with the
 * `mountDrives` option of `SandboxInstance.create()`.
 *
 * @example
 * ```typescript
 * const drive = await DriveInstance.createIfNotExists({ name: "shared", region: "us-pdx-1" });
 * await sandbox.drives.mount({ driveName: drive.name, mountPath: "/mnt/shared" });
 * await sandbox.fs.write("/mnt/shared/hello.txt", "visible to every sandbox mounting the drive");
 * ```
 */
export class DriveInstance {
  constructor(private drive: Drive) {}

  /** Drive metadata: name, displayName, labels, timestamps. */
  get metadata() {
    return this.drive.metadata;
  }

  /** Drive settings: `region` and `permissions`. */
  get spec() {
    return this.drive.spec;
  }

  /** Runtime state, including the S3-compatible endpoint URL of the drive content (`s3Url`). */
  get state() {
    return this.drive.state;
  }

  /** Status when this object was fetched, computed from its events. Not refreshed; call `DriveInstance.get()` again. */
  get status() {
    return this.drive.status;
  }

  /** Drive name, used to mount it. */
  get name() {
    return this.drive.metadata.name;
  }

  /** Human-readable name. */
  get displayName() {
    return this.drive.metadata.displayName;
  }

  /** @deprecated Only legacy drives created with a size still report one. */
  get size() {
    return (this.drive.spec as { size?: number }).size;
  }

  /** Region of the drive. */
  get region() {
    return this.drive.spec.region;
  }

  /** Access rules of the drive; undefined or empty means every workload in the workspace. */
  get permissions() {
    return this.drive.spec?.permissions;
  }

  /**
   * Create a drive. Use `createIfNotExists()` to reuse one with the same name.
   *
   * @param config - Shorthand `{ name?, displayName?, labels?, region?, permissions? }`
   * (region defaults to `BL_REGION`, with a warning when neither is set), or a
   * full `Drive` with `metadata` and `spec`.
   * @returns The new drive.
   * @throws When a drive with the name already exists (HTTP 409) or the configuration is invalid (HTTP 400).
   *
   * @example
   * ```typescript
   * const drive = await DriveInstance.create({ name: "datasets", region: "us-pdx-1" });
   * ```
   */
  static async create(config: DriveCreateConfiguration | Drive) {
    const defaultName = `drive-${uuidv4().replace(/-/g, '').substring(0, 8)}`;

    let drive: Drive;

    // Handle DriveCreateConfiguration or simple config object
    if ('spec' in config && 'metadata' in config) {
      // It's already a Drive object
      drive = config;
    } else {
      drive = {
        metadata: {
          name: config.name || defaultName,
          displayName: config.displayName || config.name || defaultName,
          labels: config.labels
        },
        spec: {
          region: config.region || settings.region,
          permissions: config.permissions,
        }
      };
    }

    // Ensure required fields have defaults
    if (!drive.metadata) {
      drive.metadata = { name: defaultName };
    }
    if (!drive.metadata.name) {
      drive.metadata.name = defaultName;
    }
    if (!drive.spec) {
      drive.spec = {};
    }
    if (!drive.spec.region && settings.region) {
      drive.spec.region = settings.region;
    }
    if (!drive.spec.region) {
      console.warn(
        "DriveInstance.create: 'region' is not set. In a future version, 'region' will be a required parameter. " +
        "Please specify a region (e.g. 'us-pdx-1', 'eu-lon-1', 'eu-dub-1') in the drive configuration or set the BL_REGION environment variable."
      );
    }

    const { data } = await createDrive({
      body: drive,
      throwOnError: true,
    });

    return new DriveInstance(data);
  }

  /**
   * Get a drive by name.
   *
   * @param driveName - The drive name.
   * @returns The drive.
   * @throws When no drive has this name (HTTP 404).
   */
  static async get(driveName: string) {
    const { data } = await getDrive({
      path: {
        driveName,
      },
      throwOnError: true,
    });
    return new DriveInstance(data);
  }

  /**
   * List one page of drives.
   *
   * The returned page exposes `data` for the current page, `meta` for cursor
   * metadata, and helpers to fetch more pages only when you need them.
   *
   * @example
   * ```ts
   * const page = await DriveInstance.list({ limit: 50 });
   *
   * for (const drive of page.data) {
   *   console.log(drive.name);
   * }
   *
   * const nextPage = await page.nextPage();
   * ```
   *
   * @example
   * ```ts
   * const allDrives = await (await DriveInstance.list()).autoPagingToArray({
   *   limit: 1000,
   * });
   * ```
   */
  static async list(query?: DriveListQuery) {
    const fetchPage = async (pageQuery?: DriveListQuery) => {
      const { data } = await listDrives({
        query: pageQuery,
        throwOnError: true,
      });
      return data;
    };
    return createPaginatedList({
      response: await fetchPage(query),
      fetchPage,
      mapItem: (drive) => new DriveInstance(drive),
      query,
    });
  }

  /**
   * Delete a drive and its content. Deletion is asynchronous: the drive is
   * reported as `DELETING` until its content is removed.
   *
   * @param driveName - The drive name.
   * @returns The drive `name`, its `status` and a message.
   */
  static async delete(driveName: string) {
    const { data } = await deleteDrive({
      path: {
        driveName,
      },
      throwOnError: true,
    });
    return data;
  }

  /**
   * Delete this drive and its content. See the static `DriveInstance.delete()`.
   *
   * @returns The drive `name`, its `status` and a message.
   */
  async delete() {
    return await DriveInstance.delete(this.metadata.name);
  }

  /**
   * Update a drive: reads it, merges the given fields, and writes it back.
   * Only `displayName`, `labels` and `permissions` can change; changing
   * `region` is rejected. `labels` and `permissions` replace the current values.
   *
   * @param driveName - The drive name.
   * @param updates - Fields to change; fields left out keep their value.
   * @returns The updated drive.
   */
  static async update(driveName: string, updates: DriveCreateConfiguration | Drive): Promise<DriveInstance> {
    const drive = await DriveInstance.get(driveName);

    const metadataUpdates: Record<string, unknown> = {};
    const specUpdates: Record<string, unknown> = {};

    if ('spec' in updates && 'metadata' in updates) {
      // It's a Drive object - only include defined fields
      if (updates.metadata) {
        if (updates.metadata.displayName !== undefined) metadataUpdates.displayName = updates.metadata.displayName;
        if (updates.metadata.labels !== undefined) metadataUpdates.labels = updates.metadata.labels;
      }
      if (updates.spec) {
        if (updates.spec.region !== undefined) specUpdates.region = updates.spec.region;
        if (updates.spec.permissions !== undefined) specUpdates.permissions = updates.spec.permissions;
      }
    } else {
      // It's a DriveCreateConfiguration - only include defined fields
      if (updates.displayName !== undefined) metadataUpdates.displayName = updates.displayName;
      if (updates.labels !== undefined) metadataUpdates.labels = updates.labels;
      if (updates.region !== undefined) specUpdates.region = updates.region;
      if (updates.permissions !== undefined) specUpdates.permissions = updates.permissions;
    }

    const body = {
      metadata: {
        ...drive.metadata,
        ...metadataUpdates,
      },
      spec: {
        ...drive.spec,
        ...specUpdates,
      },
    };

    const { data } = await updateDrive({
      path: { driveName },
      body,
      throwOnError: true,
    });

    const newDrive: Drive = {
      metadata: data.metadata,
      spec: data.spec,
      events: data.events,
      state: data.state,
      status: data.status,
    }
    // This is for safe update
    await new Promise(resolve => setTimeout(resolve, 500))
    return new DriveInstance(newDrive);
  }

  /**
   * Update this drive. See the static `DriveInstance.update()`.
   *
   * @param updates - Fields to change: `displayName`, `labels`, `permissions`.
   * @returns The updated drive, as a new instance.
   */
  async update(updates: DriveCreateConfiguration | Drive): Promise<DriveInstance> {
    const updated = await DriveInstance.update(this.metadata.name, updates);
    return updated;
  }

  /**
   * Create a drive, or return the existing one with the same name. The
   * existing drive is returned as it is: a different `region` or
   * `permissions` in `config` is not applied.
   *
   * @param config - As for `create()`. Set a `name`, otherwise a new drive is always created.
   * @returns The new or existing drive.
   *
   * @example
   * ```typescript
   * const drive = await DriveInstance.createIfNotExists({ name: "shared", region: "us-pdx-1" });
   * ```
   */
  static async createIfNotExists(config: DriveCreateConfiguration | Drive) {
    try {
      return await DriveInstance.create(config);
    } catch (e) {
      if (typeof e === "object" && e !== null && "code" in e && (e.code === 409 || e.code === 'DRIVE_ALREADY_EXISTS')) {
        const name = 'name' in config ? config.name : (config as Drive).metadata.name;
        if (!name) {
          throw new Error("Drive name is required");
        }
        const driveInstance = await DriveInstance.get(name);
        return driveInstance;
      }
      throw e;
    }
  }
}
