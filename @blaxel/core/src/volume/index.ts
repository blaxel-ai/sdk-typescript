import { v4 as uuidv4 } from "uuid";
import { createVolume, deleteVolume, getVolume, listVolumes, updateVolume, Volume } from "../client/index.js";
import { settings } from "../common/settings.js";

export interface VolumeCreateConfiguration {
  name?: string;
  displayName?: string;
  labels?: Record<string, string>;
  size?: number; // Size in MB
  region?: string; // AWS region
  template?: string; // Template
}

export class VolumeInstance {
  constructor(private volume: Volume) {}

  get metadata() {
    return this.volume.metadata;
  }

  get spec() {
    return this.volume.spec;
  }

  get status() {
    return this.volume.status;
  }

  get name() {
    return this.volume.metadata.name;
  }

  get displayName() {
    return this.volume.metadata.displayName;
  }

  get size() {
    return this.volume.spec.size;
  }

  get region() {
    return this.volume.spec.region;
  }

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

    const { data } = await createVolume({
      body: volume,
      throwOnError: true,
    });

    return new VolumeInstance(data);
  }

  static async get(volumeName: string) {
    const { data } = await getVolume({
      path: {
        volumeName,
      },
      throwOnError: true,
    });
    return new VolumeInstance(data);
  }

  static async list() {
    const { data } = await listVolumes({ throwOnError: true });
    return data.map((volume) => new VolumeInstance(volume));
  }

  static async delete(volumeName: string) {
    const { data } = await deleteVolume({
      path: {
        volumeName,
      },
      throwOnError: true,
    });
    return data;
  }

  async delete() {
    return await VolumeInstance.delete(this.metadata.name);
  }

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
    return new VolumeInstance(newVolume);
  }

  async update(updates: VolumeCreateConfiguration | Volume): Promise<VolumeInstance> {
    const updated = await VolumeInstance.update(this.metadata.name, updates);
    return updated;
  }

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
