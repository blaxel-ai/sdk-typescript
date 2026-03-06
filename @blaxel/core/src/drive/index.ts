import { v4 as uuidv4 } from "uuid";
import { createDrive, deleteDrive, getDrive, listDrives, updateDrive, Drive } from "../client/index.js";
import { settings } from "../common/settings.js";

export interface DriveCreateConfiguration {
  name?: string;
  displayName?: string;
  labels?: Record<string, string>;
  size?: number; // Size in GB
  region?: string;
}

export class DriveInstance {
  constructor(private drive: Drive) {}

  get metadata() {
    return this.drive.metadata;
  }

  get spec() {
    return this.drive.spec;
  }

  get state() {
    return this.drive.state;
  }

  get status() {
    return this.drive.status;
  }

  get name() {
    return this.drive.metadata.name;
  }

  get displayName() {
    return this.drive.metadata.displayName;
  }

  get size() {
    return this.drive.spec.size;
  }

  get region() {
    return this.drive.spec.region;
  }

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
          size: config.size,
          region: config.region || settings.region
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

  static async get(driveName: string) {
    const { data } = await getDrive({
      path: {
        driveName,
      },
      throwOnError: true,
    });
    return new DriveInstance(data);
  }

  static async list() {
    const { data } = await listDrives({ throwOnError: true });
    return data.map((drive) => new DriveInstance(drive));
  }

  static async delete(driveName: string) {
    const { data } = await deleteDrive({
      path: {
        driveName,
      },
      throwOnError: true,
    });
    return data;
  }

  async delete() {
    return await DriveInstance.delete(this.metadata.name);
  }

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
        if (updates.spec.size !== undefined) specUpdates.size = updates.spec.size;
        if (updates.spec.region !== undefined) specUpdates.region = updates.spec.region;
      }
    } else {
      // It's a DriveCreateConfiguration - only include defined fields
      if (updates.displayName !== undefined) metadataUpdates.displayName = updates.displayName;
      if (updates.labels !== undefined) metadataUpdates.labels = updates.labels;
      if (updates.size !== undefined) specUpdates.size = updates.size;
      if (updates.region !== undefined) specUpdates.region = updates.region;
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

  async update(updates: DriveCreateConfiguration | Drive): Promise<DriveInstance> {
    const updated = await DriveInstance.update(this.metadata.name, updates);
    return updated;
  }

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
