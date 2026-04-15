/**
 * Local Docker-based sandbox environment.
 *
 * Provides the same SandboxInstance API surface but backs sandbox lifecycle
 * with Docker containers on the developer's machine. Control-plane-only
 * operations (previews, sessions, tokens, drives) are shimmed with an
 * in-memory store so that callers see consistent state without hitting
 * any remote API.
 */

import { execSync } from "child_process";
import { v4 as uuidv4 } from "uuid";
import type {
  Metadata,
  Port,
  Preview,
  PreviewToken,
  SandboxSpec,
  Status,
  SandboxConfiguration,
  SessionCreateOptions,
  SessionWithToken,
  DriveMountRequest,
  DriveMountResponse,
  DriveMountInfo,
  DriveUnmountResponse,
} from "@blaxel/core";
import { SandboxInstance } from "@blaxel/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LocalSandboxOptions {
  /** Docker image to run. Defaults to "blaxel/base-image:latest". */
  image?: string;
  /** Container name override. Auto-generated when omitted. */
  name?: string;
  /** Memory limit in MB. Defaults to 4096. */
  memory?: number;
  /** Ports to expose (container port -> random or fixed host port). */
  ports?: Port[];
  /** Environment variables passed to the container. */
  envs?: { name: string; value: string }[];
  /** Extra `docker run` flags (e.g. ["--gpus", "all"]). */
  extraDockerArgs?: string[];
  /** Host port the sandbox HTTP API listens on. Defaults to auto-assign. */
  hostApiPort?: number;
  /** Labels attached to the sandbox metadata. */
  labels?: Record<string, string>;
}

interface StoredPreview {
  preview: Preview;
  tokens: PreviewToken[];
}

interface ContainerState {
  containerId: string;
  config: SandboxConfiguration;
  options: LocalSandboxOptions;
  hostPort: number;
  previews: Map<string, StoredPreview>;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// In-memory registry (one per process)
// ---------------------------------------------------------------------------

const containerRegistry = new Map<string, ContainerState>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dockerExec(args: string): string {
  return execSync(`docker ${args}`, { encoding: "utf-8" }).trim();
}

function isContainerRunning(containerId: string): boolean {
  try {
    const state = dockerExec(`inspect -f "{{.State.Running}}" ${containerId}`);
    return state === "true";
  } catch {
    return false;
  }
}

function resolveHostPort(containerId: string, containerPort: number): number {
  // If the container already exited, port mapping won't exist.
  if (!isContainerRunning(containerId)) {
    let logs = "";
    try { logs = dockerExec(`logs --tail 20 ${containerId}`); } catch {}
    throw new Error(
      `Container ${containerId} is not running -- cannot resolve port ${containerPort}. ` +
      `This usually means the image crashed on startup (e.g. architecture mismatch).\n` +
      `Last logs:\n${logs}`
    );
  }
  const raw = dockerExec(
    `port ${containerId} ${containerPort}`
  );
  // Output looks like "0.0.0.0:32789" or "[::]:32789"
  const match = raw.match(/:(\d+)$/);
  if (!match) throw new Error(`Cannot resolve host port for container port ${containerPort}`);
  return parseInt(match[1], 10);
}

function generateFakeToken(): string {
  return `local-tok-${uuidv4().replace(/-/g, "")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Local Preview / Session / Token / Drive shims
// ---------------------------------------------------------------------------

class LocalPreviews {
  constructor(private state: ContainerState) {}

  private get store() {
    return this.state.previews;
  }

  async list(): Promise<Preview[]> {
    return [...this.store.values()].map((s) => s.preview);
  }

  async create(preview: Preview): Promise<Preview> {
    const name = preview.metadata.name;
    if (this.store.has(name)) {
      throw Object.assign(new Error("Preview already exists"), { code: 409 });
    }

    const port = preview.spec?.port ?? 443;
    const url = `http://localhost:${this.state.hostPort}/port/${port}`;

    const stored: Preview = {
      metadata: {
        name,
        resourceName: this.state.config.metadata.name,
        resourceType: "sandbox",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      },
      spec: {
        ...preview.spec,
        url,
        port,
      },
      status: "DEPLOYED" as Status,
    };

    this.store.set(name, { preview: stored, tokens: [] });
    return stored;
  }

  async createIfNotExists(preview: Preview): Promise<Preview> {
    const existing = this.store.get(preview.metadata.name);
    if (existing) return existing.preview;
    return this.create(preview);
  }

  async get(previewName: string): Promise<Preview> {
    const entry = this.store.get(previewName);
    if (!entry) throw Object.assign(new Error("Preview not found"), { code: 404 });
    return entry.preview;
  }

  async delete(previewName: string): Promise<Preview> {
    const entry = this.store.get(previewName);
    if (!entry) throw Object.assign(new Error("Preview not found"), { code: 404 });
    this.store.delete(previewName);
    return entry.preview;
  }

  // Token helpers used by LocalSessions
  getTokens(previewName: string): PreviewToken[] {
    return this.store.get(previewName)?.tokens ?? [];
  }

  addToken(previewName: string, token: PreviewToken): void {
    const entry = this.store.get(previewName);
    if (entry) entry.tokens.push(token);
  }

  deleteToken(previewName: string, tokenName: string): void {
    const entry = this.store.get(previewName);
    if (!entry) return;
    entry.tokens = entry.tokens.filter((t) => t.metadata.name !== tokenName);
  }
}

class LocalSessions {
  constructor(
    private state: ContainerState,
    private localPreviews: LocalPreviews
  ) {}

  async create(options: SessionCreateOptions = {}): Promise<SessionWithToken> {
    const expiresAt = options.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
    const sessionName = `session-${Date.now()}-${uuidv4().replace(/-/g, "").substring(0, 6)}`;

    const preview = await this.localPreviews.create({
      metadata: { name: sessionName },
      spec: {
        port: 443,
        public: false,
        expires: expiresAt.toISOString(),
        requestHeaders: options.requestHeaders,
        responseHeaders: options.responseHeaders,
      },
    } as Preview);

    const tokenValue = generateFakeToken();
    const token: PreviewToken = {
      metadata: {
        name: `token-${Date.now()}`,
        previewName: sessionName,
        resourceName: this.state.config.metadata.name,
        resourceType: "sandbox",
      },
      spec: {
        token: tokenValue,
        expiresAt: expiresAt.toISOString(),
        expired: false,
      },
    };
    this.localPreviews.addToken(sessionName, token);

    return {
      name: sessionName,
      url: preview.spec.url ?? `http://localhost:${this.state.hostPort}`,
      token: tokenValue,
      expiresAt,
    };
  }

  async createIfExpired(
    options: SessionCreateOptions = {},
    delta: number = 1000 * 60 * 60
  ): Promise<SessionWithToken> {
    const all = await this.list();
    if (all.length > 0) {
      const existing = all[0];
      const threshold = new Date(Date.now() + delta);
      if (new Date(existing.expiresAt) < threshold) {
        await this.delete(existing.name);
        return this.create(options);
      }
      return existing;
    }
    return this.create(options);
  }

  async list(): Promise<SessionWithToken[]> {
    const previews = await this.localPreviews.list();
    return previews
      .filter((p) => p.metadata.name.includes("session-"))
      .map((p) => {
        const tokens = this.localPreviews.getTokens(p.metadata.name);
        const firstToken = tokens[0];
        return {
          name: p.metadata.name,
          url: p.spec.url ?? "",
          token: firstToken?.spec.token ?? "",
          expiresAt: firstToken?.spec.expiresAt
            ? new Date(firstToken.spec.expiresAt)
            : new Date(),
        };
      });
  }

  async get(name: string): Promise<SessionWithToken> {
    const preview = await this.localPreviews.get(name);
    const tokens = this.localPreviews.getTokens(name);
    const firstToken = tokens[0];
    return {
      name: preview.metadata.name,
      url: preview.spec.url ?? "",
      token: firstToken?.spec.token ?? "",
      expiresAt: firstToken?.spec.expiresAt
        ? new Date(firstToken.spec.expiresAt)
        : new Date(),
    };
  }

  async delete(name: string): Promise<void> {
    await this.localPreviews.delete(name);
  }
}

class LocalDrives {
  private mounts: DriveMountInfo[] = [];

  async mount(request: DriveMountRequest): Promise<DriveMountResponse> {
    const info: DriveMountInfo = {
      driveName: request.driveName,
      mountPath: request.mountPath,
      drivePath: request.drivePath ?? "/",
    };
    this.mounts.push(info);
    return {
      success: true,
      message: `[local] Drive ${request.driveName} mounted at ${request.mountPath} (no-op in local mode)`,
      ...info,
    };
  }

  async unmount(mountPath: string): Promise<DriveUnmountResponse> {
    const normalized = mountPath.startsWith("/") ? mountPath : `/${mountPath}`;
    this.mounts = this.mounts.filter((m) => m.mountPath !== normalized);
    return {
      success: true,
      message: `[local] Unmounted ${normalized} (no-op in local mode)`,
      mountPath: normalized,
    };
  }

  async list(): Promise<DriveMountInfo[]> {
    return [...this.mounts];
  }
}

// ---------------------------------------------------------------------------
// LocalSandboxInstance
// ---------------------------------------------------------------------------

export class LocalSandboxInstance extends SandboxInstance {
  /** Locally-shimmed previews (in-memory, no control plane). */
  declare previews: LocalPreviews;
  /** Locally-shimmed sessions (in-memory, no control plane). */
  declare sessions: LocalSessions;
  /** Locally-shimmed drives (no-op, in-memory). */
  declare drives: LocalDrives;

  private containerState: ContainerState;

  private constructor(config: SandboxConfiguration, state: ContainerState) {
    super(config);

    this.containerState = state;

    // Replace control-plane subsystems with local shims
    const localPreviews = new LocalPreviews(state);
    this.previews = localPreviews as any;
    this.sessions = new LocalSessions(state, localPreviews) as any;
    this.drives = new LocalDrives() as any;
  }

  // -- Static lifecycle methods (backed by Docker) -------------------------

  /**
   * Create a sandbox backed by a local Docker container.
   *
   * ```ts
   * const sb = await LocalSandboxInstance.create({ image: "my-app:dev", ports: [{ target: 8080 }] });
   * await sb.process.exec({ name: "ls", command: ["ls", "-la"] });
   * ```
   */
  static async create(
    opts: LocalSandboxOptions = {}
  ): Promise<LocalSandboxInstance> {
    const name = opts.name ?? `sandbox-${uuidv4().replace(/-/g, "").substring(0, 8)}`;
    const image = opts.image ?? "blaxel/base-image:latest";
    const memory = opts.memory ?? 4096;
    const ports = opts.ports ?? [];
    const envs = opts.envs ?? [];
    const extraArgs = opts.extraDockerArgs ?? [];

    // Build docker run command
    const args: string[] = ["run", "-d", "--name", name, `--memory=${memory}m`];

    // Publish the sandbox API port (we always need at least one for forceUrl)
    if (opts.hostApiPort) {
      args.push("-p", `${opts.hostApiPort}:8080`);
    } else {
      args.push("-p", "8080"); // auto-assign
    }

    // Publish user-requested ports
    for (const port of ports) {
      args.push("-p", `${port.target}`);
    }

    // Env vars
    for (const env of envs) {
      args.push("-e", `${env.name}=${env.value}`);
    }

    args.push(...extraArgs, image);

    const containerId = dockerExec(args.join(" "));
    const hostPort = resolveHostPort(containerId, 8080);
    const forceUrl = `http://localhost:${hostPort}`;

    const config: SandboxConfiguration = {
      metadata: {
        name,
        url: forceUrl,
        labels: opts.labels,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      } as Metadata,
      spec: {
        runtime: { image, memory, ports },
      } as SandboxSpec,
      status: "DEPLOYED" as Status,
      forceUrl,
      headers: {},
      params: {},
      h2Session: null,
    };

    const state: ContainerState = {
      containerId,
      config,
      options: opts,
      hostPort,
      previews: new Map(),
      createdAt: nowIso(),
    };

    containerRegistry.set(name, state);

    return new LocalSandboxInstance(config, state);
  }

  /**
   * Retrieve a previously created local sandbox by name.
   */
  static async get(sandboxName: string): Promise<LocalSandboxInstance> {
    const state = containerRegistry.get(sandboxName);
    if (!state) {
      throw Object.assign(
        new Error(`Local sandbox "${sandboxName}" not found`),
        { code: 404 }
      );
    }

    if (!isContainerRunning(state.containerId)) {
      state.config.status = "TERMINATED" as Status;
    }

    return new LocalSandboxInstance(state.config, state);
  }

  /**
   * List all local sandboxes tracked in this process.
   */
  static async list(): Promise<LocalSandboxInstance[]> {
    const instances: LocalSandboxInstance[] = [];
    for (const [, state] of containerRegistry) {
      if (!isContainerRunning(state.containerId)) {
        state.config.status = "TERMINATED" as Status;
      }
      instances.push(new LocalSandboxInstance(state.config, state));
    }
    return instances;
  }

  /**
   * Stop and remove the Docker container, then clean up the registry.
   */
  static async delete(sandboxName: string): Promise<void> {
    const state = containerRegistry.get(sandboxName);
    if (!state) {
      throw Object.assign(
        new Error(`Local sandbox "${sandboxName}" not found`),
        { code: 404 }
      );
    }
    try {
      dockerExec(`rm -f ${state.containerId}`);
    } catch {
      // Container may already be gone
    }
    containerRegistry.delete(sandboxName);
  }

  async delete(): Promise<void> {
    await LocalSandboxInstance.delete(this.metadata.name!);
  }

  /**
   * Create a sandbox if one with the same name does not already exist.
   */
  static async createIfNotExists(
    opts: LocalSandboxOptions = {}
  ): Promise<LocalSandboxInstance> {
    const name = opts.name;
    if (name && containerRegistry.has(name)) {
      const state = containerRegistry.get(name)!;
      if (isContainerRunning(state.containerId)) {
        return new LocalSandboxInstance(state.config, state);
      }
      // Terminated -- recreate
      containerRegistry.delete(name);
      try { dockerExec(`rm -f ${state.containerId}`); } catch {}
    }
    return LocalSandboxInstance.create(opts);
  }

  // -- Metadata updates (local-only, no control plane) ---------------------

  static async updateMetadata(
    sandboxName: string,
    metadata: { labels?: Record<string, string>; displayName?: string }
  ): Promise<LocalSandboxInstance> {
    const instance = await LocalSandboxInstance.get(sandboxName);
    const state = containerRegistry.get(sandboxName)!;
    if (metadata.labels) {
      (state.config.metadata as any).labels = {
        ...(state.config.metadata as any).labels,
        ...metadata.labels,
      };
    }
    if (metadata.displayName) {
      state.config.metadata.displayName = metadata.displayName;
    }
    state.config.metadata.updatedAt = nowIso();
    return instance;
  }

  static async updateTtl(
    sandboxName: string,
    _ttl: string
  ): Promise<LocalSandboxInstance> {
    // TTL has no meaning locally -- just return the instance
    return LocalSandboxInstance.get(sandboxName);
  }

  static async updateLifecycle(
    sandboxName: string,
    _lifecycle: any
  ): Promise<LocalSandboxInstance> {
    return LocalSandboxInstance.get(sandboxName);
  }

  // -- fromSession (local variant) -----------------------------------------

  /**
   * Build a `LocalSandboxInstance` from a session produced by `sessions.create()`.
   * Since the session already contains a localhost URL, we just wire it up.
   */
  static async fromSession(session: SessionWithToken): Promise<LocalSandboxInstance> {
    const sandboxName = session.name.includes("-")
      ? session.name.split("-")[0]
      : session.name;

    // If we have the sandbox in our registry, use it
    const state = containerRegistry.get(sandboxName);
    if (state) {
      const config: SandboxConfiguration = {
        ...state.config,
        forceUrl: session.url,
        headers: { "X-Blaxel-Preview-Token": session.token },
        params: { bl_preview_token: session.token },
      };
      return new LocalSandboxInstance(config, state);
    }

    // Fallback: build a minimal instance pointing at the session URL
    const config: SandboxConfiguration = {
      metadata: { name: sandboxName } as Metadata,
      spec: {} as SandboxSpec,
      forceUrl: session.url,
      headers: { "X-Blaxel-Preview-Token": session.token },
      params: { bl_preview_token: session.token },
      h2Session: null,
    };
    const fallbackState: ContainerState = {
      containerId: "unknown",
      config,
      options: {},
      hostPort: 0,
      previews: new Map(),
      createdAt: nowIso(),
    };
    return new LocalSandboxInstance(config, fallbackState);
  }

}
