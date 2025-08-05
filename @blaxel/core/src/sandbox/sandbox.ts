import { v4 as uuidv4 } from "uuid";
import { createSandbox, deleteSandbox, getSandbox, listSandboxes, Sandbox as SandboxModel } from "../client/index.js";
import { logger } from "../common/logger.js";
import { SandboxFileSystem } from "./filesystem/index.js";
import { SandboxNetwork } from "./network/index.js";
import { SandboxPreviews } from "./preview.js";
import { SandboxProcess } from "./process/index.js";
import { SandboxSessions } from "./session.js";
import { normalizeEnvs, normalizePorts, SandboxConfiguration, SandboxCreateConfiguration, SessionWithToken } from "./types.js";

export class SandboxInstance {
  fs: SandboxFileSystem;
  network: SandboxNetwork;
  process: SandboxProcess;
  previews: SandboxPreviews;
  sessions: SandboxSessions;

  constructor(private sandbox: SandboxConfiguration) {
    this.fs = new SandboxFileSystem(sandbox);
    this.network = new SandboxNetwork(sandbox);
    this.process = new SandboxProcess(sandbox);
    this.previews = new SandboxPreviews(sandbox);
    this.sessions = new SandboxSessions(sandbox);
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

  async wait({maxWait = 60000, interval = 1000}: {maxWait?: number, interval?: number} = {}) {
    const startTime = Date.now();
    while (this.sandbox.status !== "DEPLOYED") {
      await new Promise((resolve) => setTimeout(resolve, interval));
      try {
        const { data } = await getSandbox({
          path: {
            sandboxName: this.sandbox.metadata?.name ?? "",
          },
          throwOnError: true,
        });
        logger.debug(`Waiting for sandbox to be deployed, status: ${data.status}`);
        this.sandbox = data;
      } catch(e) {
        logger.error("Could not retrieve sandbox", e);
      }
      if (this.sandbox.status === "FAILED") {
        throw new Error("Sandbox failed to deploy");
      }
      if (Date.now() - startTime > maxWait) {
        throw new Error("Sandbox did not deploy in time");
      }
    }
    if (this.sandbox.status === "DEPLOYED") {
      try {
        // This is a hack for sometime receiving a 502,
        // need to remove this once we have a better way to handle this
        await this.fs.ls("/")
      } catch {
        // pass
      }
    }
    return this;
  }

  static async create(sandbox?: SandboxModel | SandboxCreateConfiguration) {
    const defaultName = `sandbox-${uuidv4().replace(/-/g, '').substring(0, 8)}`
    const defaultImage = "blaxel/prod-base:latest"
    const defaultMemory = 4096

    // Handle SandboxCreateConfiguration or simple dict with name/image/memory/ports/envs keys
    if (!sandbox || 'name' in sandbox || 'image' in sandbox || 'memory' in sandbox || 'ports' in sandbox || 'envs' in sandbox) {
      if (!sandbox) sandbox = {} as SandboxCreateConfiguration
      if (!sandbox.name) sandbox.name = defaultName
      if (!sandbox.image) sandbox.image = defaultImage
      if (!sandbox.memory) sandbox.memory = defaultMemory

      const ports = normalizePorts(sandbox.ports);
      const envs = normalizeEnvs(sandbox.envs);
      const ttl = sandbox.ttl;
      const expires = sandbox.expires;

      sandbox = {
        metadata: { name: sandbox.name },
        spec: {
          runtime: {
            image: sandbox.image,
            memory: sandbox.memory,
            ports: ports,
            envs: envs,
            generation: "mk3",
          }
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
      sandbox.metadata = { name: crypto.randomUUID().replace(/-/g, '') };
    }
    if (!sandbox.spec) {
      sandbox.spec = { runtime: { image: "blaxel/prod-base:latest" } };
    }
    if (!sandbox.spec.runtime) {
      sandbox.spec.runtime = { image: defaultImage, memory: defaultMemory };
    }

    sandbox.spec.runtime.image = sandbox.spec.runtime.image || defaultImage;
    sandbox.spec.runtime.memory = sandbox.spec.runtime.memory || defaultMemory;
    sandbox.spec.runtime.generation = sandbox.spec.runtime.generation || "mk3";

    const { data } = await createSandbox({
      body: sandbox,
      throwOnError: true,
    });
    return new SandboxInstance(data);
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

  static async createIfNotExists(sandbox: SandboxModel | SandboxCreateConfiguration) {
    try {
      const name = 'name' in sandbox ? sandbox.name : (sandbox as SandboxModel).metadata?.name
      if (!name) {
        throw new Error("Sandbox name is required");
      }
      const sandboxInstance = await SandboxInstance.get(name);
      return sandboxInstance;
    } catch (e) {
      if (typeof e === "object" && e !== null && "code" in e && e.code === 404) {
        return SandboxInstance.create(sandbox);
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
      forceUrl: session.url,
      headers: { "X-Blaxel-Preview-Token": session.token },
      params: { bl_preview_token: session.token }
    };

    // Create instance using constructor instead of direct property assignment
    return new SandboxInstance(sandbox);
  }
}
