import { v4 as uuidv4 } from "uuid";
import { createVolume, deleteVolume, getVolume, listVolumes, Volume } from "../client/index.js";

export interface VolumeCreateConfiguration {
  name?: string;
  displayName?: string;
  size?: number; // Size in MB
  region?: string; // AWS region
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
    return this.volume.metadata?.name;
  }

  get displayName() {
    return this.volume.metadata?.displayName;
  }

  get size() {
    return this.volume.spec?.size;
  }

  get region() {
    return this.volume.spec?.region;
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
      // It's a VolumeCreateConfiguration
      const volumeConfig = config as VolumeCreateConfiguration;

      volume = {
        metadata: {
          name: volumeConfig.name || defaultName,
          displayName: volumeConfig.displayName || volumeConfig.name || defaultName
        },
        spec: {
          size: volumeConfig.size || defaultSize,
          region: volumeConfig.region
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

  static async createIfNotExists(config: VolumeCreateConfiguration | Volume) {
    try {
      return await VolumeInstance.create(config);
    } catch (e) {
      if (typeof e === "object" && e !== null && "code" in e && (e.code === 409 || e.code === 'VOLUME_ALREADY_EXISTS')) {
        const name = 'name' in config ? config.name : (config as Volume).metadata?.name;
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
