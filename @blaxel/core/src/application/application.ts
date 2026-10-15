import { v4 as uuidv4 } from "uuid";
import {
  createApplication,
  deleteApplication,
  getApplication,
  listApplications,
  updateApplication,
  listApplicationRevisions,
} from "../client/index.js";
import type { Application as ApplicationModel, ApplicationSpec, AppRevision, Env } from "../client/index.js";
import { settings } from "../common/settings.js";

export type ApplicationCreateConfiguration = {
  name?: string;
  displayName?: string;
  labels?: Record<string, string>;
  enabled?: boolean;
  region?: string;
  image?: string;
  memory?: number;
  port?: number;
  envs?: Env[];
};

export class ApplicationInstance {
  constructor(private application: ApplicationModel) {}

  get metadata() {
    return this.application.metadata;
  }

  get status() {
    return this.application.status;
  }

  get spec() {
    return this.application.spec;
  }

  get events() {
    return this.application.events;
  }

  get name() {
    return this.application.metadata.name;
  }

  static async create(config: ApplicationCreateConfiguration | ApplicationModel): Promise<ApplicationInstance> {
    const defaultName = `app-${uuidv4().replace(/-/g, "").substring(0, 8)}`;

    let body: ApplicationModel;

    if ("spec" in config && "metadata" in config) {
      body = config;
    } else {
      const cfg = config;
      body = {
        metadata: {
          name: cfg.name || defaultName,
          displayName: cfg.displayName || cfg.name || defaultName,
          labels: cfg.labels,
        },
        spec: {
          enabled: cfg.enabled ?? true,
          region: cfg.region || settings.region,
          image: cfg.image,
          memory: cfg.memory,
          port: cfg.port,
          envs: cfg.envs,
        },
      };
    }

    if (!body.metadata) {
      body.metadata = { name: defaultName };
    }
    if (!body.metadata.name) {
      body.metadata.name = defaultName;
    }

    const { data } = await createApplication({
      body,
      throwOnError: true,
    });

    return new ApplicationInstance(data);
  }

  static async get(applicationName: string): Promise<ApplicationInstance> {
    const { data } = await getApplication({
      path: { applicationName },
      throwOnError: true,
    });
    return new ApplicationInstance(data);
  }

  static async list(): Promise<ApplicationInstance[]> {
    const { data } = await listApplications({ throwOnError: true });
    const items = Array.isArray(data) ? data : (data.data ?? []);
    return items.map((app: ApplicationModel) => new ApplicationInstance(app));
  }

  static async delete(applicationName: string): Promise<ApplicationModel> {
    const { data } = await deleteApplication({
      path: { applicationName },
      throwOnError: true,
    });
    return data;
  }

  async delete(): Promise<ApplicationModel> {
    return await ApplicationInstance.delete(this.metadata.name);
  }

  static async update(
    applicationName: string,
    updates: ApplicationCreateConfiguration | ApplicationModel
  ): Promise<ApplicationInstance> {
    const existing = await ApplicationInstance.get(applicationName);

    let body: ApplicationModel;

    if ("spec" in updates && "metadata" in updates) {
      body = {
        metadata: {
          ...existing.metadata,
          ...updates.metadata,
        },
        spec: {
          ...existing.spec,
          ...updates.spec,
        },
      };
    } else {
      const cfg = updates;
      const metadataUpdates: Record<string, unknown> = {};
      const specUpdates: Partial<ApplicationSpec> = {};

      if (cfg.displayName !== undefined) metadataUpdates.displayName = cfg.displayName;
      if (cfg.labels !== undefined) metadataUpdates.labels = cfg.labels;
      if (cfg.enabled !== undefined) specUpdates.enabled = cfg.enabled;
      if (cfg.region !== undefined) specUpdates.region = cfg.region;
      if (cfg.image !== undefined) specUpdates.image = cfg.image;
      if (cfg.memory !== undefined) specUpdates.memory = cfg.memory;
      if (cfg.port !== undefined) specUpdates.port = cfg.port;
      if (cfg.envs !== undefined) specUpdates.envs = cfg.envs;

      body = {
        metadata: {
          ...existing.metadata,
          ...metadataUpdates,
        },
        spec: {
          ...existing.spec,
          ...specUpdates,
        },
      };
    }

    const { data } = await updateApplication({
      path: { applicationName },
      body,
      throwOnError: true,
    });

    return new ApplicationInstance(data);
  }

  async update(updates: ApplicationCreateConfiguration | ApplicationModel): Promise<ApplicationInstance> {
    return await ApplicationInstance.update(this.metadata.name, updates);
  }

  async listRevisions(): Promise<AppRevision[]> {
    const { data } = await listApplicationRevisions({
      path: { applicationName: this.metadata.name },
      throwOnError: true,
    });
    return data;
  }
}
