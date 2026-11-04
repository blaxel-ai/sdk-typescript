import { v4 as uuidv4 } from "uuid";
import { createVolume, deleteVolume, getVolume, listVolumes, updateVolume, type ListVolumesData, type Volume } from "../client/index.js";
import { createPaginatedList } from "../common/pagination.js";
import { settings } from "../common/settings.js";

export type VolumeListQuery = NonNullable<ListVolumesData["query"]>;

/** Shorthand configuration of `VolumeInstance.create()` and `update()`. Every field is optional. */
export type VolumeCreateConfiguration = {
  /**
   * Volume name, unique in the workspace: lowercase letters, digits and
   * hyphens, at most 49 characters. Defaults to `volume-<8 hex characters>`.
   * Immutable.
   */
  name?: string;
  /** Human-readable name, at most 63 characters. Defaults to the name. */
  displayName?: string;
  /** Labels. Keys and values must be valid Kubernetes labels (values: at most 63 letters, digits, `-`, `_` or `.`), otherwise HTTP 400. */
  labels?: Record<string, string>;
  /** Size in MB. Defaults to 1024. Can be increased later, never decreased. */
  size?: number; // Size in MB
  /**
   * Region, such as `"us-pdx-1"`, `"us-was-1"` or `"eu-lon-1"`. Defaults to
   * the `BL_REGION` environment variable. Must match the region of the
   * sandboxes that attach the volume. Immutable.
   */
  region?: string; // AWS region
  /** Volume template to initialize the content from, as `"name"` or `"name:revision"` (latest when omitted). Immutable. */
  template?: string; // Template
};

/**
 * A persistent volume: block storage that keeps its data across sandbox
 * deletions. Attach it when creating a sandbox with `volumes: [{ name,
 * mountPath }]`. A volume is attached to one sandbox at a time, must be in
 * the sandbox's region, and must be detached (its sandbox deleted) before it
 * can be deleted.
 *
 * @example
 * ```typescript
 * const volume = await VolumeInstance.createIfNotExists({
 *   name: "my-data",
 *   size: 2048,
 *   region: "us-pdx-1",
 * });
 * const sandbox = await SandboxInstance.create({
 *   region: "us-pdx-1",
 *   volumes: [{ name: volume.name, mountPath: "/data" }],
 * });
 * ```
 */
export class VolumeInstance {
  constructor(private volume: Volume) {}

  /** Volume metadata: name, displayName, labels, timestamps. */
  get metadata() {
    return this.volume.metadata;
  }

  /** Volume settings: `size` (MB), `region`, `template` and `attachedTo`. */
  get spec() {
    return this.volume.spec;
  }

  /** Status when this object was fetched, such as `DEPLOYING`, `DEPLOYED` or `DELETING`. Not refreshed; call `VolumeInstance.get()` again. */
  get status() {
    return this.volume.status;
  }

  /** Volume name, used to attach it to a sandbox. */
  get name() {
    return this.volume.metadata.name;
  }

  /** Human-readable name. */
  get displayName() {
    return this.volume.metadata.displayName;
  }

  /** Size in MB. */
  get size() {
    return this.volume.spec.size;
  }

  /** Region of the volume. */
  get region() {
    return this.volume.spec.region;
  }

  /**
   * Create a volume. Use `createIfNotExists()` to reuse one with the same name.
   *
   * @param config - Shorthand `{ name?, displayName?, labels?, size?, region?, template? }`
   * (size in MB, default 1024; region defaults to `BL_REGION`, with a warning
   * when neither is set), or a full `Volume` with `metadata` and `spec`.
   * @returns The new volume.
   * @throws When a volume with the name already exists (HTTP 409) or the configuration is invalid (HTTP 400).
   *
   * @example
   * ```typescript
   * const volume = await VolumeInstance.create({ name: "cache", size: 4096, region: "us-pdx-1" });
   * ```
   */
  static async create(config: VolumeCreateConfiguration | Volume) {
    const defaultName = `volume-${uuidv4().replace(/-/g, '').substring(0, 8)}`;
    const defaultSize = 1024; // 1GB in MB

    let volume: Volume;

    // Handle VolumeCreateConfiguration or simple config object
    if ('spec' in config && 'metadata' in config) {
      // It's already a Volume object
      volume = config;
    } else {
      volume = {
        metadata: {
          name: config.name || defaultName,
          displayName: config.displayName || config.name || defaultName,
          labels: config.labels
        },
        spec: {
          size: config.size || defaultSize,
          region: config.region || settings.region,
          template: config.template
        }
      };
    }

    // Ensure required fields have defaults
    if (!volume.metadata) {
      volume.metadata = { name: defaultName };
    }
    if (!volume.metadata.name) {
      volume.metadata.name = defaultName;
    }
    if (!volume.spec) {
      volume.spec = { size: defaultSize };
    }
    if (!volume.spec.size) {
      volume.spec.size = defaultSize;
    }
    if (!volume.spec.region && settings.region) {
      volume.spec.region = settings.region;
    }
    if (!volume.spec.region) {
      console.warn(
        "VolumeInstance.create: 'region' is not set. In a future version, 'region' will be a required parameter. " +
        "Please specify a region (e.g. 'us-pdx-1', 'eu-lon-1', 'us-was-1') in the volume configuration or set the BL_REGION environment variable."
      );
    }

    const { data } = await createVolume({
      body: volume,
      throwOnError: true,
    });

    return new VolumeInstance(data);
  }

  /**
   * Get a volume by name.
   *
   * @param volumeName - The volume name.
   * @returns The volume.
   * @throws When no volume has this name (HTTP 404).
   */
  static async get(volumeName: string) {
    const { data } = await getVolume({
      path: {
        volumeName,
      },
      throwOnError: true,
    });
    return new VolumeInstance(data);
  }

  /**
   * List one page of volumes.
   *
   * The returned page exposes `data` for the current page, `meta` for cursor
   * metadata, and helpers to fetch more pages only when you need them.
   *
   * @example
   * ```ts
   * const page = await VolumeInstance.list({ limit: 50 });
   *
   * for (const volume of page.data) {
   *   console.log(volume.name);
   * }
   *
   * const nextPage = await page.nextPage();
   * ```
   *
   * @example
   * ```ts
   * const page = await VolumeInstance.list({ limit: 100 });
   *
   * for await (const volume of page) {
   *   console.log(volume.name);
   * }
   * ```
   */
  static async list(query?: VolumeListQuery) {
    const fetchPage = async (pageQuery?: VolumeListQuery) => {
      const { data } = await listVolumes({
        query: pageQuery,
        throwOnError: true,
      });
      return data;
    };
    return createPaginatedList({
      response: await fetchPage(query),
      fetchPage,
      mapItem: (volume) => new VolumeInstance(volume as Volume),
      query,
    });
  }

  /**
   * Delete a volume and its data. The volume must not be attached: delete the
   * sandbox using it first.
   *
   * @param volumeName - The volume name.
   * @returns The deleted volume.
   */
  static async delete(volumeName: string) {
    const { data } = await deleteVolume({
      path: {
        volumeName,
      },
      throwOnError: true,
    });
    return data;
  }

  /**
   * Delete this volume and its data. It must not be attached to a sandbox.
   *
   * @returns The deleted volume.
   */
  async delete() {
    return await VolumeInstance.delete(this.metadata.name);
  }

  /**
   * Update a volume: reads it, merges the given fields, and writes it back.
   * Only `size` (increase only), `displayName` and `labels` can change;
   * changing `region` or `template` is rejected. `labels` replaces the whole map.
   *
   * @param volumeName - The volume name.
   * @param updates - Fields to change; fields left out keep their value.
   * @returns The updated volume.
   *
   * @example
   * ```typescript
   * await VolumeInstance.update("cache", { size: 8192 });
   * ```
   */
  static async update(volumeName: string, updates: VolumeCreateConfiguration | Volume): Promise<VolumeInstance> {
    const volume = await VolumeInstance.get(volumeName);

    const metadataUpdates: Record<string, unknown> = {};
    const specUpdates: Record<string, unknown> = {};

    if ('spec' in updates && 'metadata' in updates) {
      // It's a Volume object - only include defined fields
      if (updates.metadata) {
        if (updates.metadata.displayName !== undefined) metadataUpdates.displayName = updates.metadata.displayName;
        if (updates.metadata.labels !== undefined) metadataUpdates.labels = updates.metadata.labels;
      }
      if (updates.spec) {
        if (updates.spec.size !== undefined) specUpdates.size = updates.spec.size;
        if (updates.spec.region !== undefined) specUpdates.region = updates.spec.region;
        if (updates.spec.template !== undefined) specUpdates.template = updates.spec.template;
      }
    } else {
      // It's a VolumeCreateConfiguration - only include defined fields
      if (updates.displayName !== undefined) metadataUpdates.displayName = updates.displayName;
      if (updates.labels !== undefined) metadataUpdates.labels = updates.labels;
      if (updates.size !== undefined) specUpdates.size = updates.size;
      if (updates.region !== undefined) specUpdates.region = updates.region;
      if (updates.template !== undefined) specUpdates.template = updates.template;
    }

    const body = {
      metadata: {
        ...volume.metadata,
        ...metadataUpdates,
      },
      spec: {
        ...volume.spec,
        ...specUpdates,
      },
    };

    const { data } = await updateVolume({
      path: { volumeName },
      body,
      throwOnError: true,
    });

    const newVolume: Volume = {
      metadata: data.metadata,
      spec: data.spec,
      events: data.events,
      state: data.state,
      status: data.status,
      terminatedAt: data.terminatedAt,
    }
    // This is for safe update
    await new Promise(resolve => setTimeout(resolve, 500))
    return new VolumeInstance(newVolume);
  }

  /**
   * Update this volume. See the static `VolumeInstance.update()`.
   *
   * @param updates - Fields to change: `size` (increase only), `displayName`, `labels`.
   * @returns The updated volume, as a new instance.
   */
  async update(updates: VolumeCreateConfiguration | Volume): Promise<VolumeInstance> {
    const updated = await VolumeInstance.update(this.metadata.name, updates);
    return updated;
  }

  /**
   * Create a volume, or return the existing one with the same name. The
   * existing volume is returned as it is: a different `size` or `region` in
   * `config` is not applied.
   *
   * @param config - As for `create()`. Set a `name`, otherwise a new volume is always created.
   * @returns The new or existing volume.
   *
   * @example
   * ```typescript
   * const volume = await VolumeInstance.createIfNotExists({ name: "my-data", region: "us-pdx-1" });
   * ```
   */
  static async createIfNotExists(config: VolumeCreateConfiguration | Volume) {
    try {
      return await VolumeInstance.create(config);
    } catch (e) {
      if (typeof e === "object" && e !== null && "code" in e && (e.code === 409 || e.code === 'VOLUME_ALREADY_EXISTS')) {
        const name = 'name' in config ? config.name : (config as Volume).metadata.name;
        if (!name) {
          throw new Error("Volume name is required");
        }
        const volumeInstance = await VolumeInstance.get(name);
        return volumeInstance;
      }
      throw e;
    }
  }
}
