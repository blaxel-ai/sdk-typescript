import type http2 from "http2";
import { archiveSandbox, createSandbox, createSandboxSnapshot, deleteSandbox, deleteSandboxSnapshot, type Env, forkSandbox, getSandbox, getSandboxByExternalId, listSandboxes, listSandboxSnapshots, type ListSandboxesData, restoreSandboxSnapshot, type SandboxForkResponse, type SandboxLifecycle, type Sandbox as SandboxModel, type SandboxRestoreResponse, type SandboxSnapshot, unarchiveSandbox, updateSandbox } from "../client/index.js";
import { logger } from "../common/logger.js";
import { backoffDelayMs, GATEWAY_ERROR_STATUSES, isTransientResetError, retryOnTransientReset } from "../common/transient-retry.js";
import { createPaginatedList } from "../common/pagination.js";
import { settings } from "../common/settings.js";
import { ResponseError } from "./action.js";
import { SandboxCodegen } from "./codegen/index.js";
import { SandboxDrive } from "./drive/index.js";
import { SandboxFileSystem } from "./filesystem/index.js";
import { SandboxNetwork } from "./network/index.js";
import { SandboxPreviews } from "./preview.js";
import { SandboxProcess } from "./process/index.js";
import { SandboxSchedules } from "./schedule.js";
import { SandboxSnapshotsResource } from "./snapshot.js";
import { SandboxSessions } from "./session.js";
import { SandboxSystem } from "./system.js";
import { normalizeEnvs, normalizePorts, normalizeVolumes, SandboxConfiguration, SandboxCreateConfiguration, SandboxUpdateMetadata, SandboxUpdateNetwork, SessionWithToken } from "./types.js";

export type SandboxListQuery = NonNullable<ListSandboxesData["query"]>;

export type SandboxForkOptions = {
  /** Resource type to fork into. Defaults to "sandbox". */
  targetType?: "sandbox" | "application";
  /** Port to expose from the fork. */
  port?: number;
  /** Canary traffic percentage (0-100) when forking into an application. */
  traffic?: number;
  /** Custom domain for the application fork. */
  customDomain?: string;
  /** URL prefix for the application fork. */
  prefix?: string;
  /**
   * Snapshot ID to fork from. When set, the fork is created from this existing
   * snapshot — this is how you create a sandbox from a snapshot. When omitted,
   * a sandbox fork copies the source sandbox's live state directly, without
   * persisting a snapshot in between.
   */
  snapshotId?: string;
  /**
   * Environment variables the fork runs with, on top of the ones the source
   * has: a variable the source already carries takes this value in the fork,
   * one it does not is added, and every other variable of the source is kept.
   */
  envs?: Env[];
  /**
   * Lifecycle the fork runs with, replacing the source's. When omitted, a
   * sandbox fork keeps the source's lifecycle and its runtime ttl and expires.
   * Only valid when targetType is "sandbox".
   */
  lifecycle?: SandboxLifecycle;
};

// Archiving a filesystem, and restoring it, take as long as that filesystem is
// big — minutes for a few gigabytes.
const ARCHIVE_MAX_WAIT_MS = 1_800_000;
const ARCHIVE_WAIT_POLL_MS = 2_000;
// An archive is done when the sandbox is ARCHIVED; it is still under way while
// the record holds one of these.
const ARCHIVING_STATUSES = new Set(["ARCHIVING"]);
// A restore is done when the sandbox is DEPLOYED again; the instance is recreated
// before the archived filesystem is written back over its image.
const UNARCHIVING_STATUSES = new Set(["UNARCHIVING", "DEPLOYING", "BUILDING", "UPLOADING"]);
// The status the sandbox holds before the operation moves it, tolerated only
// while the operation is starting: an archive that fails hands the sandbox back
// as DEPLOYED and a restore that fails leaves it ARCHIVED, so reading the entry
// status once the operation has begun means it is over, not still running.
const ARCHIVE_ENTRY_STATUS = "DEPLOYED";
const UNARCHIVE_ENTRY_STATUS = "ARCHIVED";
const ARCHIVE_ENTRY_MAX_WAIT_MS = 30_000;

// A reset switches the sandbox off and on again: the instance is torn down and
// deployed again from its image, which takes a few seconds (2-7s measured).
const RESET_MAX_WAIT_MS = 120_000;
const RESET_POLL_MS = 500;
// The statuses a reset can start from. Any other status (TERMINATED and
// DELETING above all: updating a record that is being, or has been, deleted
// brings the sandbox back to life) is refused before anything is written.
const RESETTABLE_STATUSES = new Set(["DEPLOYED", "DEPLOYING", "DEACTIVATING", "DEACTIVATED", "FAILED"]);
const RESET_ENTRY_OFF_STATUSES = new Set(["DEACTIVATING", "DEACTIVATED"]);
// Right after the switch-on write the record can still read as off while the
// control plane starts the redeploy. That is tolerated only until the redeploy
// has been seen, and never past the wait the caller asked for.
const RESET_ENTRY_MAX_WAIT_MS = 30_000;

// One reset's wait: maxWait covers the teardown and the redeploy together.
type ResetWait = { deadline: number; interval: number; seconds: number };

/** How long to wait for a reset to finish. */
export type SandboxResetOptions = {
  /** Give up waiting for the reset after this many milliseconds; -1 waits indefinitely. Defaults to 2 minutes. */
  maxWait?: number;
  /** Milliseconds between two reads of the sandbox. Defaults to 500 milliseconds. */
  interval?: number;
};

/** How long to wait for an archive, or its restore, to finish. */
export type SandboxArchiveOptions = {
  /** Wait for the archive/restore to finish. Defaults to true. */
  wait?: boolean;
  /** Give up after this many milliseconds. Defaults to 30 minutes. */
  maxWait?: number;
  /** Milliseconds between two reads of the sandbox. Defaults to 2 seconds. */
  interval?: number;
};

// A create that outlives the edge's 60s origin-read timeout gets a 504 from
// CloudFront while the control plane keeps deploying the sandbox for up to
// 300s (ENG-3662 timeout ladder inversion). The 504 body is edge HTML with no
// usable payload, so the record is polled instead until it settles.
// Polling backs off exponentially (1s, 2s, 4s, then 5s + jitter) so a fleet of
// clients stuck in this window does not hammer the control plane every second.
const CREATE_GATEWAY_TIMEOUT_MAX_WAIT_MS = 120_000;
const CREATE_GATEWAY_TIMEOUT_BASE_POLL_MS = 1_000;
const CREATE_GATEWAY_TIMEOUT_MAX_POLL_MS = 5_000;

// A creation deadline the caller sets per request through an undocumented
// header; it can only shorten the control plane's default. Capped below the
// edge's 60s origin-read timeout so the control plane's 408 always reaches the
// client instead of being masked by an edge 504.
const CREATION_TIMEOUT_HEADER = "X-Blaxel-Creation-Timeout";
export const MAX_CREATION_TIMEOUT_SECONDS = 50;

/** Options of SandboxInstance.create / createIfNotExists. */
export type SandboxCreateOptions = {
  /** Check the sandbox answers (fs.ls) and delete it if it does not. Defaults to false. */
  safe?: boolean;
  /** Return the existing sandbox instead of failing when the name is taken. */
  createIfNotExist?: boolean;
  /**
   * Give up on the creation after this many seconds (whole number, 1 to
   * MAX_CREATION_TIMEOUT_SECONDS). The control plane releases the sandbox
   * and the call rejects with a SandboxCreationTimeoutError. Unset, the
   * control plane's default deadline applies.
   */
  timeout?: number;
};

/**
 * Thrown by SandboxInstance.create / createIfNotExists when the sandbox was
 * not ready within the creation deadline. The control plane has released the
 * sandbox, so the name is free again and the creation can simply be started
 * over. Catch it with `err instanceof SandboxCreationTimeoutError` or
 * `isCreationTimeoutError(err)`.
 */
export class SandboxCreationTimeoutError extends Error {
  readonly code = "CREATION_TIMEOUT";
  readonly status = 408;
  /** Raw error body returned by the control plane. */
  readonly data: unknown;

  constructor(
    /** Name of the sandbox that was being created, if one was requested. */
    readonly sandboxName: string | undefined,
    /** The `timeout` option of the call, in seconds; undefined when the control plane's default applied. */
    readonly timeout: number | undefined,
    data: unknown,
  ) {
    const detail = typeof data === "object" && data !== null && typeof (data as { message?: unknown }).message === "string"
      ? (data as { message: string }).message
      : undefined;
    const target = sandboxName ? `Sandbox ${sandboxName}` : "Sandbox";
    const deadline = timeout !== undefined ? ` within ${timeout}s` : " within the creation deadline";
    super(`${target} was not ready${deadline}; the creation was cancelled.${detail ? ` ${detail}` : ""}`);
    this.name = "SandboxCreationTimeoutError";
    this.data = data;
  }
}

/** True when `err` is a sandbox creation timeout (408 CREATION_TIMEOUT). */
export function isCreationTimeoutError(err: unknown): err is SandboxCreationTimeoutError {
  return err instanceof SandboxCreationTimeoutError;
}

const isCreationTimeoutResponse = (status: number | undefined, e: unknown): boolean => {
  if (status === 408) return true;
  if (typeof e !== "object" || e === null) return false;
  return (e as { code?: unknown }).code === "CREATION_TIMEOUT";
};

function validateCreateOptions({ timeout }: SandboxCreateOptions): { timeout?: number } {
  if (timeout === undefined) return {};
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_CREATION_TIMEOUT_SECONDS) {
    throw new Error(`SandboxInstance.create: 'timeout' must be a whole number of seconds between 1 and ${MAX_CREATION_TIMEOUT_SECONDS}, got ${timeout}.`);
  }
  return { timeout };
}

const isSandboxNotFound = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null) return false;
  const candidate = e as { code?: unknown; status?: unknown };
  return candidate.code === 404 || candidate.code === "404" || candidate.status === 404;
};

// A call that reached no sandbox yet: the route is not up (404 WORKLOAD_UNAVAILABLE),
// the edge could not reach it, or the connection dropped. Safe to try again.
const isNotYetRoutable = (e: unknown): boolean => {
  if (e instanceof ResponseError) {
    return e.status === 404 || (e.status !== undefined && GATEWAY_ERROR_STATUSES.has(e.status));
  }
  return !(typeof e === "object" && e !== null && "status" in e) || isTransientResetError(e);
};

// The control plane's error bodies are plain objects ({ code, error }), not Errors.
const describeApiError = (e: unknown): string => {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null) {
    const { error, message, code } = e as { error?: unknown; message?: unknown; code?: string | number };
    const text = [error, message].find((v) => typeof v === "string");
    if (typeof text === "string") return code !== undefined ? `${text} (${code})` : text;
  }
  return String(e);
};

export class SandboxInstance {
  fs: SandboxFileSystem;
  network: SandboxNetwork;
  process: SandboxProcess;
  previews: SandboxPreviews;
  schedules: SandboxSchedules;
  sessions: SandboxSessions;
  codegen: SandboxCodegen;
  system: SandboxSystem;
  drives: SandboxDrive;
  snapshots: SandboxSnapshotsResource;
  h2Session: http2.ClientHttp2Session | null;

  constructor(private sandbox: SandboxConfiguration) {
    this.process = new SandboxProcess(sandbox);
    this.fs = new SandboxFileSystem(sandbox, this.process);
    this.network = new SandboxNetwork(sandbox);
    this.previews = new SandboxPreviews(sandbox);
    this.schedules = new SandboxSchedules(sandbox);
    this.sessions = new SandboxSessions(sandbox);
    this.codegen = new SandboxCodegen(sandbox);
    this.system = new SandboxSystem(sandbox);
    this.drives = new SandboxDrive(sandbox);
    this.snapshots = new SandboxSnapshotsResource(sandbox);
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
   * Infrastructure failures the compute plane recorded for this sandbox, oldest
   * first. Entries with `fatal: true` are the ones that moved it to FAILED; the
   * others (e.g. a microVM that exited and restarted) are informational. Only
   * returned when a single sandbox is read, never in listings.
   */
  get errors() {
    return this.sandbox.errors ?? [];
  }

  get h2Domain() {
    return this.sandbox.h2Domain ?? null;
  }

  /**
   * Warm and attach an H2 session based on the sandbox's region.
   * Shared by create(), get(), list(), and update helpers.
   */
  private static async attachH2Session(instance: SandboxInstance): Promise<SandboxInstance> {
    const edgeDomain = SandboxInstance.edgeDomainForRegion(instance.spec?.region);
    if (!edgeDomain || settings.disableH2) return instance;
    try {
      const { h2Pool } = await import("../common/h2pool.js");
      const h2Session = await h2Pool.get(edgeDomain);
      instance.h2Session = h2Session;
      instance.sandbox.h2Session = h2Session;
      instance.sandbox.h2Domain = edgeDomain;
    } catch {
      // H2 warming is best-effort; fall back to regular fetch
    }
    return instance;
  }

  private static edgeDomainForRegion(region?: string): string | null {
    if (!region) return null;
    const edgeSuffix = settings.env === "prod" ? "bl.run" : "runv2.blaxel.dev";
    return `any.${region}.${edgeSuffix}`;
  }

  get expiresIn() {
    return this.sandbox.expiresIn;
  }

  /**
   * Fetch a resource served on a sandbox port.
   *
   * @param port - The port number inside the sandbox
   * @param path - Optional path appended after the port (default: "/")
   * @param init - Standard RequestInit options forwarded to fetch
   */
  async fetch(port: number, path = "/", init?: RequestInit): Promise<Response> {
    return this.network.fetch(port, path, init);
  }

  /**
   * Create a point-in-time snapshot of this sandbox. Snapshots capture the
   * sandbox state and can be forked into new sandboxes or applications.
   *
   * @param name - Optional human-readable name for the snapshot.
   * @deprecated Use `sandbox.snapshots.create(name)`.
   */
  async snapshot(name?: string): Promise<SandboxSnapshot> {
    const { data } = await createSandboxSnapshot({
      path: { sandboxName: this.metadata.name },
      body: name ? { name } : {},
      throwOnError: true,
    });
    return data;
  }

  /**
   * List the snapshots of this sandbox.
   *
   * @deprecated Use `sandbox.snapshots.list()`.
   */
  async listSnapshots(): Promise<SandboxSnapshot[]> {
    const { data } = await listSandboxSnapshots({
      path: { sandboxName: this.metadata.name },
      throwOnError: true,
    });
    return data;
  }

  /**
   * Delete a snapshot of this sandbox by its ID.
   *
   * @deprecated Use `sandbox.snapshots.delete(name)`.
   */
  async deleteSnapshot(snapshotId: string): Promise<void> {
    await deleteSandboxSnapshot({
      path: { sandboxName: this.metadata.name, snapshotId },
      throwOnError: true,
    });
  }

  /**
   * Restore this sandbox to one of its own snapshots. The sandbox keeps its
   * name, its URLs and its previews: the running instance is torn down and
   * rebuilt from the snapshot, so everything written since it was taken is
   * lost unless it was snapshotted too.
   *
   * The restore is asked for without waiting on the guest, the same way a fork
   * is: connections to a sandbox still resuming are retried by the gateway.
   *
   * @param snapshotId - ID of the snapshot to restore this sandbox to.
   * @deprecated Use `sandbox.snapshots.restore(name)`.
   */
  async restore(snapshotId: string): Promise<SandboxRestoreResponse> {
    const { data } = await restoreSandboxSnapshot({
      path: { sandboxName: this.metadata.name, snapshotId },
      throwOnError: true,
    });
    return data;
  }

  /**
   * Fork this sandbox into a new sandbox or application.
   *
   * Forking into a sandbox copies the source sandbox's live state straight into
   * the fork: no snapshot is taken, persisted, or left behind, and the returned
   * `snapshotId` is empty.
   *
   * Pass `snapshotId` to fork from an existing snapshot instead of the source's
   * live state (create a sandbox from a snapshot). Forking into an application
   * (`targetType: "application"`) still goes through a snapshot, which is
   * recorded because the application revision references it. In both of those
   * cases the response carries the snapshot the fork came from.
   *
   * @param targetName - Name of the sandbox/application to create.
   * @param options - Fork options (target type, port, traffic, snapshot, ...).
   */
  async fork(targetName: string, options: SandboxForkOptions = {}): Promise<SandboxForkResponse> {
    const { data } = await forkSandbox({
      path: { sandboxName: this.metadata.name },
      body: {
        targetName,
        targetType: options.targetType ?? "sandbox",
        ...(options.port !== undefined ? { port: options.port } : {}),
        ...(options.traffic !== undefined ? { traffic: options.traffic } : {}),
        ...(options.customDomain !== undefined ? { customDomain: options.customDomain } : {}),
        ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
        ...(options.snapshotId !== undefined ? { snapshotId: options.snapshotId } : {}),
        ...(options.envs !== undefined ? { envs: options.envs } : {}),
        ...(options.lifecycle !== undefined ? { lifecycle: options.lifecycle } : {}),
      },
      throwOnError: true,
    });
    return data;
  }

  /* eslint-disable */
  async wait({ maxWait = 60000, interval = 1000 }: { maxWait?: number, interval?: number } = {}) {
    logger.warn("⚠️  Warning: sandbox.wait() is deprecated. You don't need to wait for the sandbox to be deployed anymore.");
    return this;
  }

  static async create(sandbox?: SandboxModel | SandboxCreateConfiguration, options: SandboxCreateOptions = {}) {
    const { safe = false, createIfNotExist = false } = options;
    const { timeout } = validateCreateOptions(options);
    // No client-side default name: when the caller omits a name we send the
    // creation without metadata.name so the server can assign one and unnamed
    // creations become eligible for warm sandbox pools (ENG-3931).
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
      'labels' in sandbox ||
      'extraArgs' in sandbox
    ) {
      if (!sandbox) sandbox = {} as SandboxCreateConfiguration
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
      const extraArgs = sandbox.extraArgs;

      sandbox = {
        metadata: { name: sandbox.name, labels: sandbox.labels, externalId: sandbox.externalId },
        spec: {
          region: region,
          runtime: {
            image: sandbox.image,
            memory: sandbox.memory,
            ports: ports,
            envs: envs,
            generation: "mk3",
            snapshotEnabled,
            extraArgs,
          },
          volumes: volumes,
          lifecycle: lifecycle,
          network: network,
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
      // Leave name unset so the server assigns one (ENG-3931).
      sandbox.metadata = {} as SandboxModel["metadata"];
    }
    if (!sandbox.spec) {
      sandbox.spec = { runtime: { image: defaultImage, memory: defaultMemory } };
    }
    if (!sandbox.spec.runtime) {
      sandbox.spec.runtime = { image: defaultImage, memory: defaultMemory };
    }

    sandbox.spec.runtime.image = sandbox.spec.runtime.image || defaultImage;
    sandbox.spec.runtime.memory = sandbox.spec.runtime.memory || defaultMemory;

    const edgeDomain = SandboxInstance.edgeDomainForRegion(sandbox.spec?.region);

    // Kick off warming so h2Pool.get() can join it during the API call
    if (edgeDomain && !settings.disableH2) {
      import("../common/h2pool.js").then(({ h2Pool }) => h2Pool.warm(edgeDomain)).catch(() => { });
    }

    const headers = timeout !== undefined ? { [CREATION_TIMEOUT_HEADER]: String(timeout) } : undefined;
    const [createResult, h2Session] = await Promise.all([
      createSandbox({
        body: sandbox,
        query: createIfNotExist ? { createIfNotExist } : undefined,
        headers,
      }),
      edgeDomain && !settings.disableH2 ? import("../common/h2pool.js").then(({ h2Pool }) => h2Pool.get(edgeDomain)).catch(() => null) : Promise.resolve(null),
    ]);
    let data = createResult.data;
    if (createResult.error !== undefined) {
      const name = sandbox.metadata.name;
      if (isCreationTimeoutResponse(createResult.response.status, createResult.error)) {
        throw new SandboxCreationTimeoutError(name, timeout, createResult.error);
      }
      if (createResult.response.status === 504 && name) {
        // The edge gave up on the connection but the creation is still running
        // server-side; wait for the record instead of failing (ENG-3662).
        data = await SandboxInstance.waitAfterCreateGatewayTimeout(name, createResult.error);
      } else {
        throw createResult.error;
      }
    }
    // Inject the H2 session into the config so subsystems can use it
    const config = { ...data, h2Session, h2Domain: settings.disableH2 ? null : edgeDomain } as SandboxConfiguration;
    const instance = new SandboxInstance(config);
    instance.h2Session = h2Session;
    // Note: H2 session already attached via Promise.all above, no need for attachH2Session()
    // TODO remove this part once we have a better way to handle this
    if (safe) {
      try {
        await instance.fs.ls('/')
      } catch (err) {
        await SandboxInstance.delete(instance.metadata.name!).catch(() => { });
        throw err;
      }
    }
    return instance;
  }

  /**
   * Archive a sandbox: keep its filesystem, stop the sandbox.
   *
   * The filesystem changes made over the image are exported to the archive store
   * and the sandbox is shut down; memory and running processes are lost, and the
   * saved processes start again from their configuration when the sandbox is
   * unarchived. The export runs in the background: this waits until the sandbox
   * is ARCHIVED, pass `{ wait: false }` to return as soon as it is launched.
   */
  static async archive(sandboxName: string, options: SandboxArchiveOptions = {}) {
    const { data } = await archiveSandbox({
      path: { sandboxName },
      throwOnError: true,
    });
    return SandboxInstance.waitForArchiveStatus(sandboxName, data, "ARCHIVED", ARCHIVING_STATUSES, ARCHIVE_ENTRY_STATUS, "archive", options);
  }

  /**
   * Archive this sandbox: keep its filesystem, stop the sandbox.
   *
   * @see SandboxInstance.archive
   */
  async archive(options: SandboxArchiveOptions = {}) {
    const instance = await SandboxInstance.archive(this.metadata.name!, options);
    this.refreshFrom(instance);
    return this;
  }

  /**
   * Recreate an archived sandbox from its archive.
   *
   * The sandbox is started again from its image, and the archived filesystem is
   * written back over it. The sandbox answers, and its terminal is reachable, while the archived
   * filesystem is written back over its image. This waits until the restore is
   * done and the saved processes are running again; pass `{ wait: false }` to
   * return while the sandbox is still UNARCHIVING.
   */
  static async unarchive(sandboxName: string, options: SandboxArchiveOptions = {}) {
    const { data } = await unarchiveSandbox({
      path: { sandboxName },
      throwOnError: true,
    });
    return SandboxInstance.waitForArchiveStatus(sandboxName, data, "DEPLOYED", UNARCHIVING_STATUSES, UNARCHIVE_ENTRY_STATUS, "unarchive", options);
  }

  /**
   * Recreate this sandbox from its archive.
   *
   * @see SandboxInstance.unarchive
   */
  async unarchive(options: SandboxArchiveOptions = {}) {
    const instance = await SandboxInstance.unarchive(this.metadata.name!, options);
    this.refreshFrom(instance);
    return this;
  }

  /**
   * Reset a sandbox to a fresh copy of its image.
   *
   * The sandbox is taken down and deployed again from its image: everything
   * written to its filesystem since it started and every running process are
   * gone, as after a delete and a create. Unlike a delete and a create, the
   * sandbox is never absent: it keeps its name and URL, its spec, its
   * environment variables (secret values included), its volumes and the data
   * on them, its previews, preview tokens and sessions. Running processes, and
   * anything mounted from inside the sandbox such as a drive, belong to the old
   * instance and have to be started or mounted again.
   *
   * This waits until the old instance is gone and the sandbox is DEPLOYED
   * again and answers, a few seconds. A sandbox that is disabled is switched
   * back on. Sandboxes that are archived or being deleted cannot be reset.
   *
   * It works by switching the sandbox off and on again (`spec.enabled`). If
   * the old instance is still running when `maxWait` runs out, or the second
   * write fails, the sandbox is left DEACTIVATED and the error says so:
   * calling `reset` again finishes the reset.
   */
  static async reset(sandboxName: string, options: SandboxResetOptions = {}): Promise<SandboxInstance> {
    const { maxWait = RESET_MAX_WAIT_MS, interval = RESET_POLL_MS } = options;
    const wait: ResetWait = {
      deadline: maxWait === -1 ? Infinity : Date.now() + maxWait,
      interval,
      seconds: Math.round(maxWait / 1000),
    };
    const current = await SandboxInstance.get(sandboxName);
    const status = current.status ?? "";
    if (!RESETTABLE_STATUSES.has(status)) {
      throw new Error(`Sandbox ${sandboxName} is ${status || "in an unknown state"} and cannot be reset`);
    }

    // The body is the sandbox as the control plane returns it: the values of
    // secret environment variables come back masked and are kept as stored.
    let record: SandboxModel = { metadata: current.metadata, spec: current.spec };
    if (current.spec.enabled !== false && !RESET_ENTRY_OFF_STATUSES.has(status)) {
      try {
        record = await SandboxInstance.writeEnabled(sandboxName, record, false);
      } catch (e) {
        throw new Error(`Sandbox ${sandboxName} could not be reset, it was left as it was: ${describeApiError(e)}`, { cause: e });
      }
      // Writing it back on only redeploys a sandbox that was really taken down.
      if (record.spec.enabled !== false || !RESET_ENTRY_OFF_STATUSES.has(record.status ?? "")) {
        throw new Error(`Sandbox ${sandboxName} could not be reset: the control plane did not take it down (it is ${record.status})`);
      }
    }
    await SandboxInstance.waitForTeardown(sandboxName, current, wait);
    try {
      await SandboxInstance.writeEnabled(sandboxName, record, true);
    } catch (e) {
      throw new Error(
        `Sandbox ${sandboxName} was taken down for the reset but could not be switched back on, it is left DEACTIVATED; call SandboxInstance.reset("${sandboxName}") again to bring it back: ${describeApiError(e)}`,
        { cause: e },
      );
    }
    return SandboxInstance.waitForReset(sandboxName, wait);
  }

  /**
   * Reset this sandbox to a fresh copy of its image.
   *
   * @see SandboxInstance.reset
   */
  async reset(options: SandboxResetOptions = {}) {
    const instance = await SandboxInstance.reset(this.metadata.name!, options);
    this.refreshFrom(instance);
    return this;
  }

  // Write the sandbox back with spec.enabled set. Writing the same bytes twice
  // is harmless, so a transient failure is retried.
  private static async writeEnabled(sandboxName: string, record: SandboxModel, enabled: boolean): Promise<SandboxModel> {
    const { data } = await retryOnTransientReset(() => updateSandbox({
      path: { sandboxName },
      body: { metadata: record.metadata, spec: { ...record.spec, enabled } } as SandboxModel,
      throwOnError: true,
    }));
    return data;
  }

  // Wait until the instance that was switched off is gone. Switched back on
  // while it is still there, the sandbox keeps it, and its filesystem: the
  // compute plane finds the instance it would create already running and
  // leaves it in place. The record cannot tell: the control plane stamps
  // DEACTIVATED as soon as the switch-off is written and tears the instance
  // down afterwards. The sandbox's URL can: the gateway routes only to a
  // running instance and answers 404 (WORKLOAD_UNAVAILABLE) once there is none.
  private static async waitForTeardown(sandboxName: string, old: SandboxInstance, wait: ResetWait): Promise<void> {
    const leftOff = `it is left DEACTIVATED; call SandboxInstance.reset("${sandboxName}") again to finish the reset`;
    for (;;) {
      try {
        await old.fs.ls("/");
      } catch (e) {
        if (e instanceof ResponseError && e.status === 404) return;
        if (!isNotYetRoutable(e)) {
          throw new Error(`Sandbox ${sandboxName} is switched off for the reset, but whether its old instance is gone could not be checked, ${leftOff}: ${describeApiError(e)}`, { cause: e });
        }
      }
      if (Date.now() >= wait.deadline) {
        throw new Error(`Sandbox ${sandboxName} is switched off for the reset, but its old instance was still running after ${wait.seconds}s, ${leftOff}`);
      }
      await new Promise((resolve) => setTimeout(resolve, wait.interval));
    }
  }

  // Wait until the sandbox is DEPLOYED again and answers. The record turns
  // DEPLOYED a couple of seconds before the sandbox is routable, during which
  // calls get a 404 WORKLOAD_UNAVAILABLE (retryable), so DEPLOYED alone is not
  // ready.
  private static async waitForReset(sandboxName: string, { deadline, interval, seconds }: ResetWait): Promise<SandboxInstance> {
    const entryDeadline = Math.min(Date.now() + RESET_ENTRY_MAX_WAIT_MS, deadline);
    let instance: SandboxInstance | undefined;
    let redeploying = false;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      if (!instance) {
        const { data } = await retryOnTransientReset(() => getSandbox({ path: { sandboxName }, throwOnError: true }));
        if (data.status === "FAILED") {
          throw new Error(`Sandbox ${sandboxName} failed to deploy again after the reset`);
        }
        if (data.status === "DEPLOYED") {
          instance = await SandboxInstance.attachH2Session(new SandboxInstance(data));
        } else if (data.status === "DEPLOYING") {
          redeploying = true;
          if (Date.now() >= deadline) {
            throw new Error(`Sandbox ${sandboxName} is still ${data.status} after waiting ${seconds}s for it to deploy again after the reset`);
          }
        } else if (!redeploying && RESET_ENTRY_OFF_STATUSES.has(data.status ?? "") && Date.now() < entryDeadline) {
          continue;
        } else {
          throw new Error(`Sandbox ${sandboxName} is ${data.status} while it should be deployed again after the reset`);
        }
      }
      if (instance) {
        try {
          await instance.fs.ls("/");
          return instance;
        } catch (e) {
          if (!isNotYetRoutable(e)) {
            throw new Error(`Sandbox ${sandboxName} was deployed again but does not answer after the reset: ${describeApiError(e)}`, { cause: e });
          }
          if (Date.now() >= deadline) {
            throw new Error(`Sandbox ${sandboxName} was deployed again but did not answer within ${seconds}s after the reset: ${describeApiError(e)}`, { cause: e });
          }
        }
      }
    }
  }

  // The subsystems (fs, process, previews, ...) hold the configuration object
  // this instance was built with, so a refresh writes into it rather than
  // replacing it. Anything the read did not carry, the forced URL of a session
  // above all, is kept.
  private refreshFrom(instance: SandboxInstance) {
    Object.assign(this.sandbox, instance.sandbox);
  }

  private static async waitForArchiveStatus(
    sandboxName: string,
    launched: SandboxModel,
    target: string,
    pending: Set<string>,
    entry: string,
    action: string,
    { wait = true, maxWait = ARCHIVE_MAX_WAIT_MS, interval = ARCHIVE_WAIT_POLL_MS }: SandboxArchiveOptions,
  ): Promise<SandboxInstance> {
    if (!wait || launched.status === target) {
      return SandboxInstance.attachH2Session(new SandboxInstance(launched));
    }
    const deadline = Date.now() + maxWait;
    // The status the sandbox is given back at is tolerated while the operation
    // turns into a status change, but never past the wait the caller asked for.
    const entryDeadline = Date.now() + Math.min(ARCHIVE_ENTRY_MAX_WAIT_MS, maxWait);
    let started = false;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      const instance = await SandboxInstance.get(sandboxName);
      const status = instance.status;
      if (status === target) {
        return instance;
      }
      if (pending.has(status ?? "")) {
        started = true;
      } else if (status === entry && !started && Date.now() < entryDeadline) {
        continue;
      }
      if (!pending.has(status ?? "")) {
        throw new Error(`Sandbox ${sandboxName} is ${status} while it should ${action}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Sandbox ${sandboxName} is still ${status} after waiting ${Math.round(maxWait / 1000)}s for it to ${action}`);
      }
    }
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

  static async getByExternalId(externalId: string) {
    const { data } = await getSandboxByExternalId({
      path: { externalId },
      throwOnError: true,
    });
    const instance = new SandboxInstance(data);
    return SandboxInstance.attachH2Session(instance);
  }

  /**
   * List one page of sandboxes.
   *
   * The returned page exposes `data` for the current page, `meta` for cursor
   * metadata, and helpers to fetch more pages only when you need them.
   *
   * @example
   * ```ts
   * const page = await SandboxInstance.list({ limit: 50 });
   *
   * for (const sandbox of page.data) {
   *   console.log(sandbox.metadata.name);
   * }
   *
   * const nextPage = await page.nextPage();
   * ```
   *
   * @example
   * ```ts
   * const page = await SandboxInstance.list({ limit: 100 });
   *
   * for await (const sandbox of page) {
   *   console.log(sandbox.metadata.name);
   * }
   * ```
   */
  static async list(query?: SandboxListQuery) {
    const fetchPage = async (pageQuery?: SandboxListQuery) => {
      const { data } = await listSandboxes({
        query: pageQuery,
        throwOnError: true,
      });
      return data;
    };
    return createPaginatedList({
      response: await fetchPage(query),
      fetchPage,
      mapItem: (sandbox) => SandboxInstance.attachH2Session(new SandboxInstance(sandbox)),
      query,
    });
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
    this.sandbox.h2Session = null;
    this.sandbox.h2Domain = null;
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
    return SandboxInstance.attachH2Session(instance);
  }

  static async updateTtl(sandboxName: string, ttl: string | null) {
    const sandbox = await SandboxInstance.get(sandboxName);
    const body = { ...sandbox.sandbox, spec: { ...sandbox.spec, runtime: { ...sandbox.spec.runtime, ttl: ttl === '' ? null : ttl ?? null } } } as SandboxModel
    const { data } = await updateSandbox({
      path: { sandboxName },
      body,
      throwOnError: true,
    });
    const instance = new SandboxInstance(data);
    return SandboxInstance.attachH2Session(instance);
  }

  static async updateLifecycle(sandboxName: string, lifecycle: SandboxLifecycle | null) {
    const sandbox = await SandboxInstance.get(sandboxName);
    const body = { ...sandbox.sandbox, spec: { ...sandbox.spec, lifecycle: lifecycle ?? null } } as SandboxModel
    const { data } = await updateSandbox({
      path: { sandboxName },
      body,
      throwOnError: true,
    });
    const instance = new SandboxInstance(data);
    return SandboxInstance.attachH2Session(instance);
  }


  static async updateNetwork(sandboxName: string, network: SandboxUpdateNetwork) {
    const sandbox = await SandboxInstance.get(sandboxName);
    const body = { ...sandbox.sandbox, spec: { ...sandbox.spec, network: network.network } } as SandboxModel
    const { data } = await updateSandbox({
      path: { sandboxName },
      body,
      throwOnError: true,
    });
    const instance = new SandboxInstance(data);
    return SandboxInstance.attachH2Session(instance);
  }

  /**
   * Create the sandbox, or return the one already holding this name.
   *
   * The control plane owns the reconciliation: an alive sandbox is returned as
   * is, a FAILED/TERMINATED one is replaced, and a deletion or concurrent
   * creation still in flight is waited for server-side. A 409 therefore only
   * surfaces when the name really cannot be used, and is thrown as is.
   * `options` (e.g. `timeout`) are forwarded to `create`.
   */
  static async createIfNotExists(sandbox: SandboxModel | SandboxCreateConfiguration, options: Omit<SandboxCreateOptions, "createIfNotExist"> = {}) {
    return this.create(sandbox, { ...options, createIfNotExist: true });
  }

  // Poll the record after a create was cut by the edge with a 504 while the
  // control plane is still deploying it. Resolves with the sandbox once it
  // reaches DEPLOYED; throws on FAILED or once the wait budget is spent.
  private static async waitAfterCreateGatewayTimeout(name: string, createError: unknown): Promise<SandboxModel> {
    logger.debug(`Sandbox ${name} creation timed out at the edge (504); polling the record while it finishes deploying`);
    const deadline = Date.now() + CREATE_GATEWAY_TIMEOUT_MAX_WAIT_MS;
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt++;
      await new Promise((resolve) =>
        setTimeout(resolve, backoffDelayMs(attempt, CREATE_GATEWAY_TIMEOUT_BASE_POLL_MS, CREATE_GATEWAY_TIMEOUT_MAX_POLL_MS)),
      );
      let current: SandboxModel;
      try {
        const { data } = await getSandbox({ path: { sandboxName: name }, throwOnError: true });
        current = data;
      } catch (e) {
        // The record can lag behind the accepted create; keep waiting on 404.
        if (isSandboxNotFound(e)) continue;
        throw e;
      }
      if (current.status === "DEPLOYED") return current;
      if (current.status === "FAILED") {
        throw new Error(`Sandbox ${name} failed to deploy after the create timed out at the edge (504).`);
      }
    }
    throw createError;
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
