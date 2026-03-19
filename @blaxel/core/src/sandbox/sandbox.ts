import { v4 as uuidv4 } from "uuid";
import { createSandbox, deleteSandbox, getSandbox, listSandboxes, SandboxLifecycle, Sandbox as SandboxModel, updateSandbox } from "../client/index.js";
import { logger } from "../common/logger.js";
import { settings } from "../common/settings.js";
import { SandboxCodegen } from "./codegen/index.js";
import { SandboxDrive } from "./drive/index.js";
import { SandboxFileSystem } from "./filesystem/index.js";
import { SandboxNetwork } from "./network/index.js";
import { SandboxPreviews } from "./preview.js";
import { SandboxProcess } from "./process/index.js";
import { SandboxSessions } from "./session.js";
import { SandboxSystem } from "./system.js";
import { normalizeEnvs, normalizePorts, normalizeVolumes, SandboxConfiguration, SandboxCreateConfiguration, SandboxUpdateMetadata, SessionWithToken } from "./types.js";

export class SandboxInstance {
  fs: SandboxFileSystem;
  network: SandboxNetwork;
  process: SandboxProcess;
  previews: SandboxPreviews;
  sessions: SandboxSessions;
  codegen: SandboxCodegen;
  system: SandboxSystem;
  drives: SandboxDrive;
  h2Session: any;

  constructor(private sandbox: SandboxConfiguration) {
    this.process = new SandboxProcess(sandbox);
    this.fs = new SandboxFileSystem(sandbox, this.process);
    this.network = new SandboxNetwork(sandbox);
    this.previews = new SandboxPreviews(sandbox);
    this.sessions = new SandboxSessions(sandbox);
    this.codegen = new SandboxCodegen(sandbox);
    this.system = new SandboxSystem(sandbox);
    this.drives = new SandboxDrive(sandbox);
    this.h2Session = null;
  }

  get metadata() {
    return this.sandbox.metadata;
  }

  get status() {
    return this.sandbox.status;
  }

  get events() {
    return this.sandbox.events;
  }

  get spec() {
    return this.sandbox.spec;
  }

  get lastUsedAt() {
    return this.sandbox.lastUsedAt;
  }

  /**
   * Warm and attach an H2 session based on the sandbox's region.
   * Shared by create(), get(), list(), and update helpers.
   */
  private static async attachH2Session(instance: SandboxInstance): Promise<SandboxInstance> {
    const region = instance.spec?.region;
    if (!region) return instance;
    const edgeSuffix = settings.env === "prod" ? "bl.run" : "runv2.blaxel.dev";
    const edgeDomain = `any.${region}.${edgeSuffix}`;
    try {
      const { h2Pool } = await import("../common/h2pool.js");
      const h2Session = await h2Pool.get(edgeDomain);
      instance.h2Session = h2Session;
      instance.sandbox.h2Session = h2Session;
    } catch {
      // H2 warming is best-effort; fall back to regular fetch
    }
    return instance;
  }

  get expiresIn() {
    return this.sandbox.expiresIn;
  }

  // Not deprecated anymore, we are using asynchronous check if the deployment take more than 20s.
  async wait({maxWait = 180_000, interval = 1_000}: {maxWait?: number, interval?: number} = {}) {
    if (this.sandbox.status === "DEPLOYED") {
      return this;
    }
    logger.info(`Sandbox ${this.metadata.name} is deploying, waiting for it to be ready...`);
    const deadline = Date.now() + maxWait;
    while (Date.now() < deadline) {
      const { data } = await getSandbox({
        path: { sandboxName: this.metadata.name },
        throwOnError: true,
      });
      if (data.status === "DEPLOYED") {
        logger.info(`Sandbox ${this.metadata.name} is now deployed`);
        Object.assign(this.sandbox, data);
        return this;
      }
      if (data.status === "FAILED" || data.status === "TERMINATED") {
        throw new Error(`Sandbox ${this.metadata.name} reached terminal status: ${data.status}`);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`Sandbox ${this.metadata.name} did not reach DEPLOYED status within ${maxWait / 1000}s`);
  }

  static async create(sandbox?: SandboxModel | SandboxCreateConfiguration, { safe = false }: { safe?: boolean } = {}) {
    const defaultName = `sandbox-${uuidv4().replace(/-/g, '').substring(0, 8)}`
    const defaultImage = `blaxel/base-image:latest`
    const defaultMemory = 4096

    // Handle SandboxCreateConfiguration or simple dict with name/image/memory/ports/envs/volumes keys
    if (
      !sandbox ||
      'name' in sandbox ||
      'image' in sandbox ||
      'memory' in sandbox ||
      'ports' in sandbox ||
      'envs' in sandbox ||
      'volumes' in sandbox ||
      'lifecycle' in sandbox ||
      'network' in sandbox ||
      'snapshotEnabled' in sandbox ||
      'labels' in sandbox
    ) {
      if (!sandbox) sandbox = {} as SandboxCreateConfiguration
      if (!sandbox.name) sandbox.name = defaultName
      if (!sandbox.image) sandbox.image = defaultImage
      if (!sandbox.memory) sandbox.memory = defaultMemory

      const ports = normalizePorts(sandbox.ports);
      const envs = normalizeEnvs(sandbox.envs);
      const volumes = normalizeVolumes(sandbox.volumes);
      const ttl = sandbox.ttl;
      const expires = sandbox.expires;
      const region = sandbox.region || settings.region;
      if (!region) {
        console.warn(
          "SandboxInstance.create: 'region' is not set. In a future version, 'region' will be a required parameter. " +
          "Please specify a region (e.g. 'us-pdx-1', 'eu-lon-1', 'us-was-1') in the sandbox configuration or set the BL_REGION environment variable."
        );
      }
      const lifecycle = sandbox.lifecycle;
      const network = sandbox.network;
      const snapshotEnabled = sandbox.snapshotEnabled;

      sandbox = {
        metadata: { name: sandbox.name, labels: sandbox.labels },
        spec: {
          region: region,
          runtime: {
            image: sandbox.image,
            memory: sandbox.memory,
            ports: ports,
            envs: envs,
            generation: "mk3",
            snapshotEnabled,
          },
          volumes: volumes,
          lifecycle: lifecycle,
          network: network,
        }
      } as SandboxModel
      if (sandbox.spec?.runtime) {
        if (ttl) {
          sandbox.spec.runtime.ttl = ttl;
        }
        if (expires) {
          sandbox.spec.runtime.expires = expires.toISOString();
        }
      }
    }

    sandbox = sandbox as SandboxModel
    if (!sandbox.metadata) {
      sandbox.metadata = { name: defaultName };
    }
    if (!sandbox.spec) {
      sandbox.spec = { runtime: { image: defaultImage, memory: defaultMemory } };
    }
    if (!sandbox.spec.runtime) {
      sandbox.spec.runtime = { image: defaultImage, memory: defaultMemory };
    }

    sandbox.spec.runtime.image = sandbox.spec.runtime.image || defaultImage;
    sandbox.spec.runtime.memory = sandbox.spec.runtime.memory || defaultMemory;

    const edgeSuffix = settings.env === "prod" ? "bl.run" : "runv2.blaxel.dev";
    const edgeDomain = sandbox.spec?.region ? `any.${sandbox.spec.region}.${edgeSuffix}` : null;

    // Kick off warming so h2Pool.get() can join it during the API call
    if (edgeDomain) {
      import("../common/h2pool.js").then(({ h2Pool }) => h2Pool.warm(edgeDomain)).catch(() => {});
    }

    const [{ data }, h2Session] = await Promise.all([
      createSandbox({
        body: sandbox,
        throwOnError: true,
      }),
      edgeDomain ? import("../common/h2pool.js").then(({ h2Pool }) => h2Pool.get(edgeDomain)).catch(() => null) : Promise.resolve(null),
    ]);

    const config = { ...data, h2Session } as SandboxConfiguration;
    const instance = new SandboxInstance(config);
    instance.h2Session = h2Session;
    if (data.status === "DEPLOYING") {
      await instance.wait();
    }
    if (safe) {
      try {
        await instance.fs.ls('/')
      } catch { /* best-effort readiness check */ }
    }
    return instance;
  }

  static async get(sandboxName: string) {
    const { data } = await getSandbox({
      path: {
        sandboxName,
      },
      throwOnError: true,
    });
    const instance = new SandboxInstance(data);
    return SandboxInstance.attachH2Session(instance);
  }

  static async list() {
    const { data } = await listSandboxes({throwOnError: true}) as { response: Response; data: SandboxModel[] };
    const instances = data.map((sandbox) => new SandboxInstance(sandbox));
    return Promise.all(instances.map((instance) => SandboxInstance.attachH2Session(instance)));
  }

  static async delete(sandboxName: string) {
    const { data } = await deleteSandbox({
      path: {
        sandboxName,
      },
      throwOnError: true,
    });
    return data;
  }

  async delete() {
    // Don't close the H2 session — it's shared via h2Pool
    this.h2Session = null;
    return await SandboxInstance.delete(this.metadata.name);
  }

  static async updateMetadata(sandboxName: string, metadata: SandboxUpdateMetadata) {
    const sandbox = await SandboxInstance.get(sandboxName);
    const body = { ...sandbox.sandbox, metadata: { ...sandbox.metadata, ...metadata } } as SandboxModel
    const { data } = await updateSandbox({
      path: { sandboxName },
      body,
      throwOnError: true,
    });
    const instance = new SandboxInstance(data);
    return SandboxInstance.attachH2Session(instance);
  }

  static async updateTtl(sandboxName: string, ttl: string) {
    const sandbox = await SandboxInstance.get(sandboxName);
    const body = { ...sandbox.sandbox, spec: { ...sandbox.spec, runtime: { ...sandbox.spec.runtime, ttl } } } as SandboxModel
    const { data } = await updateSandbox({
      path: { sandboxName },
      body,
      throwOnError: true,
    });
    const instance = new SandboxInstance(data);
    return SandboxInstance.attachH2Session(instance);
  }

  static async updateLifecycle(sandboxName: string, lifecycle: SandboxLifecycle) {
    const sandbox = await SandboxInstance.get(sandboxName);
    const body = { ...sandbox.sandbox, spec: { ...sandbox.spec, lifecycle } } as SandboxModel
    const { data } = await updateSandbox({
      path: { sandboxName },
      body,
      throwOnError: true,
    });
    const instance = new SandboxInstance(data);
    return SandboxInstance.attachH2Session(instance);
  }

  static async createIfNotExists(sandbox: SandboxModel | SandboxCreateConfiguration) {
    try {
      return await this.create(sandbox);
    } catch (e) {
      if (typeof e === "object" && e !== null && "code" in e && (e.code === 409 || e.code === 'SANDBOX_ALREADY_EXISTS')) {
        const name = 'name' in sandbox ? sandbox.name : (sandbox as SandboxModel).metadata.name
        if (!name) {
          throw new Error("Sandbox name is required");
        }

        const sandboxInstance = await this.get(name);

        if (sandboxInstance.status === "TERMINATED") {
          return await this.create(sandbox);
        }

        if (sandboxInstance.status === "DEPLOYING") {
          await sandboxInstance.wait();
        }

        return sandboxInstance;
      }
      throw e;
    }
  }

  /* eslint-disable */
  static async fromSession(session: SessionWithToken) {
    // Create a minimal sandbox configuration for session-based access
    const sandboxName = session.name.includes("-") ? session.name.split("-")[0] : session.name;
    const sandbox: SandboxConfiguration = {
      metadata: { name: sandboxName },
      spec: {},
      forceUrl: session.url,
      headers: { "X-Blaxel-Preview-Token": session.token },
      params: { bl_preview_token: session.token }
    };

    // Create instance using constructor instead of direct property assignment
    return new SandboxInstance(sandbox);
  }
}
