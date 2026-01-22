import { v4 as uuidv4 } from "uuid";
import { createSandbox, deleteSandbox, getSandbox, listSandboxes, SandboxLifecycle, Sandbox as SandboxModel, updateSandbox } from "../client/index.js";
import { logger } from "../common/logger.js";
import { SandboxCodegen } from "./codegen/index.js";
import { SandboxFileSystem } from "./filesystem/index.js";
import { SandboxNetwork } from "./network/index.js";
import { SandboxPreviews } from "./preview.js";
import { SandboxProcess } from "./process/index.js";
import { SandboxSessions } from "./session.js";
import { normalizeEnvs, normalizePorts, normalizeVolumes, SandboxConfiguration, SandboxCreateConfiguration, SandboxUpdateMetadata, SessionWithToken } from "./types.js";

export class SandboxInstance {
  fs: SandboxFileSystem;
  network: SandboxNetwork;
  process: SandboxProcess;
  previews: SandboxPreviews;
  sessions: SandboxSessions;
  codegen: SandboxCodegen;

  constructor(private sandbox: SandboxConfiguration) {
    this.process = new SandboxProcess(sandbox);
    this.fs = new SandboxFileSystem(sandbox, this.process);
    this.network = new SandboxNetwork(sandbox);
    this.previews = new SandboxPreviews(sandbox);
    this.sessions = new SandboxSessions(sandbox);
    this.codegen = new SandboxCodegen(sandbox);
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

  /* eslint-disable */
  async wait({maxWait = 60000, interval = 1000}: {maxWait?: number, interval?: number} = {}) {
    logger.warn("⚠️  Warning: sandbox.wait() is deprecated. You don't need to wait for the sandbox to be deployed anymore.");
    return this;
  }

  static async create(sandbox?: SandboxModel | SandboxCreateConfiguration, { safe = true }: { safe?: boolean } = {}) {
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
      const region = sandbox.region;
      const lifecycle = sandbox.lifecycle;
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
        }
      } as SandboxModel
      if (ttl) {
        sandbox.spec!.runtime!.ttl = ttl;
      }
      if (expires) {
        sandbox.spec!.runtime!.expires = expires.toISOString();
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

    const { data } = await createSandbox({
      body: sandbox,
      throwOnError: true,
    });
    const instance = new SandboxInstance(data);
    // TODO remove this part once we have a better way to handle this
    if (safe) {
      try {
        await instance.fs.ls('/')
      } catch {}
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
    return new SandboxInstance(data);
  }

  static async list() {
    const { data } = await listSandboxes({throwOnError: true}) as { response: Response; data: SandboxModel[] };
    return data.map((sandbox) => new SandboxInstance(sandbox));
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
    return await SandboxInstance.delete(this.metadata.name!);
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
    return instance;
  }

  static async updateTTL(sandboxName: string, ttl: string) {
    const sandbox = await SandboxInstance.get(sandboxName);
    const body = { ...sandbox.sandbox, spec: { ...sandbox.spec, runtime: { ...sandbox.spec.runtime, ttl } } } as SandboxModel
    const { data } = await updateSandbox({
      path: { sandboxName },
      body,
      throwOnError: true,
    });
    const instance = new SandboxInstance(data);
    return instance;
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
    return instance;
  }

  static async createIfNotExists(sandbox: SandboxModel | SandboxCreateConfiguration) {
    try {
      return await SandboxInstance.create(sandbox);
    } catch (e) {
      if (typeof e === "object" && e !== null && "code" in e && (e.code === 409 || e.code === 'SANDBOX_ALREADY_EXISTS')) {
        const name = 'name' in sandbox ? sandbox.name : (sandbox as SandboxModel).metadata.name
        if (!name) {
          throw new Error("Sandbox name is required");
        }

        // Get the existing sandbox to check its status
        const sandboxInstance = await SandboxInstance.get(name);

          // If the sandbox is TERMINATED, treat it as not existing
          if (sandboxInstance.status === "TERMINATED") {
            // Create a new sandbox - backend will handle cleanup of the terminated one
            return await SandboxInstance.create(sandbox);
          }

        // Otherwise return the existing running sandbox
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
