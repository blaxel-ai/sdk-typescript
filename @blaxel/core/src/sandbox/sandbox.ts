import type http2 from "http2";
import { archiveSandbox, createSandbox, createSandboxSnapshot, deleteSandbox, deleteSandboxSnapshot, type Env, forkSandbox, getSandbox, getSandboxByExternalId, listSandboxes, listSandboxSnapshots, type ListSandboxesData, restoreSandboxSnapshot, type SandboxForkResponse, type SandboxLifecycle, type Sandbox as SandboxModel, type SandboxRestoreResponse, type SandboxSnapshot, unarchiveSandbox, updateSandbox } from "../client/index.js";
import { client as controlPlaneClient } from "../client/client.gen.js";
import { logger } from "../common/logger.js";
import { backoffDelayMs, GATEWAY_ERROR_STATUSES, isTransientResetError } from "../common/transient-retry.js";
import { createPaginatedList } from "../common/pagination.js";
import { settings } from "../common/settings.js";
import { getHealth } from "./client/index.js";
import { v4 as uuidv4 } from "uuid";
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

// A reset gives the sandbox a fresh instance booted from its image. The control
// plane does it in one call, which replaces the instance and answers once the
// new one runs. A control plane without that call is reset by switching
// spec.enabled off and on, which runs the deployment pipeline twice.
const RESET_MAX_WAIT_MS = 120_000;
const RESET_POLL_MS = 200;
// The longest single call made while waiting on the sandbox, so that one slow
// answer cannot hold the reset much past its own deadline.
const RESET_PROBE_TIMEOUT_MS = 5_000;
// The statuses a switch-off/switch-on reset can start from. Any other status
// is refused before anything is written: updating a record that is being, or
// has been, deleted (TERMINATED, DELETING) brings the sandbox back to life,
// and updating a FAILED one makes the control plane release and recreate it.
const RESETTABLE_STATUSES = new Set(["DEPLOYED", "DEPLOYING", "DEACTIVATING", "DEACTIVATED"]);
const RESET_ENTRY_OFF_STATUSES = new Set(["DEACTIVATING", "DEACTIVATED"]);
// Right after the switch-on write the record can still read as off while the
// control plane starts the redeploy. That is tolerated only until the redeploy
// has been seen, and never past the wait the caller asked for.
const RESET_ENTRY_MAX_WAIT_MS = 30_000;
// What the deployment pipeline writes on a sandbox once it has applied, or
// failed to apply, a change to it.
const DEPLOYMENT_SUCCEEDED_EVENT = "ai.blaxel.controlplane.deployment.succeeded";
const DEPLOYMENT_FAILED_EVENT = "ai.blaxel.controlplane.deployment.failed";

// One reset's wait: maxWait covers every call and every wait of the reset.
type ResetWait = { deadline: number; interval: number; seconds: number };

/** How long to wait for a reset to finish. */
export type SandboxResetOptions = {
  /** Give up waiting for the reset after this many milliseconds; -1 waits indefinitely. Defaults to 2 minutes. */
  maxWait?: number;
  /** Milliseconds between two reads of the sandbox while waiting on it. Defaults to 200 milliseconds. */
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

// How long is left of a reset's wait, in milliseconds (Infinity without one).
const remainingMs = (wait: ResetWait): number => wait.deadline - Date.now();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Run a call with a signal that aborts it after `ms`, so a call that hangs
// cannot hold a reset past its deadline. No signal without a finite limit.
async function withDeadline<T>(ms: number, call: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  if (!Number.isFinite(ms)) return call(undefined);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, ms));
  try {
    return await call(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

const isAbort = (e: unknown): boolean =>
  typeof e === "object" && e !== null && ((e as { name?: unknown }).name === "AbortError" || (e as { name?: unknown }).name === "TimeoutError");

// A control plane that has no reset call answers its route as unknown, and
// one that cannot reset this sandbox in one call answers 501: either way the
// sandbox is reset by switching it off and on.
const resetsBySwitching = (status: number, error: unknown): boolean => {
  if (status === 405 || status === 501) return true;
  const text = typeof error === "object" && error !== null ? (error as { error?: unknown }).error : error;
  return status === 404 && typeof text === "string" && /route not found/i.test(text);
};

// The control plane's error bodies carry the status as `code`; an edge error
// in front of it (502/503/504) is worth reading or writing again.
const isGatewayBody = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null) return false;
  const code = Number((e as { code?: unknown }).code);
  return GATEWAY_ERROR_STATUSES.has(code);
};

// Where the deployment pipeline is with taking a switched-off sandbox's
// instance down, read from the newest event it or the API wrote: an API write
// it has not applied yet, or a deployment it is still running, is pending.
const teardownState = (record: SandboxModel): "done" | "failed" | "pending" => {
  const events = record.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const { type, status } = events[i];
    if (type === DEPLOYMENT_SUCCEEDED_EVENT) return status === "DEACTIVATED" ? "done" : "pending";
    if (type === DEPLOYMENT_FAILED_EVENT) return "failed";
    if (type?.startsWith("ai.blaxel.controlplane.")) return "pending";
  }
  return "pending";
};

// A reset refused because the sandbox is no longer the one it started on:
// deleted, created again under the same name, or moved to another state by
// someone else. Thrown as is, whatever step it interrupts.
class ResetGenerationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResetGenerationError";
  }
}

// The record read during a reset must be the sandbox the reset started on:
// one deleted and created again under the same name has another createdAt.
const checkSameSandbox = (sandboxName: string, entry: SandboxModel, record: SandboxModel) => {
  if (record.metadata.createdAt !== entry.metadata.createdAt) {
    throw new ResetGenerationError(`Sandbox ${sandboxName} was deleted and created again during its reset; the new sandbox is left as it is`);
  }
};

const leftOff = (sandboxName: string) =>
  `it is left DEACTIVATED; call SandboxInstance.reset("${sandboxName}") again to finish the reset`;

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
   * The sandbox gets a new instance booted from its image: everything written
   * to its filesystem since it started and every running process are gone, as
   * after a delete and a create. Unlike a delete and a create, the sandbox is
   * never absent: it keeps its name and URL, its spec, its environment
   * variables (secret values included), its volumes and the data on them, its
   * previews, preview tokens and sessions. Running processes, and anything
   * mounted from inside the sandbox such as a drive, belong to the old instance
   * and have to be started or mounted again.
   *
   * The control plane replaces the instance in one call: the platform deletes
   * the old instance and boots the new one, whatever ran in the old one. This
   * then waits until the sandbox answers, about as long as a create takes.
   * Only a running (DEPLOYED) sandbox can be reset that way.
   *
   * On a control plane without that call, the sandbox is switched off and on
   * again (`spec.enabled`): the reset waits for the platform to report the old
   * instance gone, then for the redeploy. A sandbox that is disabled is
   * switched back on. If `maxWait` runs out before the old instance is gone,
   * or the second write fails, the sandbox is left DEACTIVATED and the error
   * says so: calling `reset` again finishes the reset.
   *
   * Sandboxes that are archived or being deleted cannot be reset. `maxWait`
   * bounds the whole reset, every call included.
   */
  static async reset(sandboxName: string, options: SandboxResetOptions = {}): Promise<SandboxInstance> {
    const { maxWait = RESET_MAX_WAIT_MS, interval = RESET_POLL_MS } = options;
    const wait: ResetWait = {
      deadline: maxWait === -1 ? Infinity : Date.now() + maxWait,
      interval,
      seconds: Math.round(maxWait / 1000),
    };
    // The sandbox the reset is for, read alongside the reset call so that it
    // adds no wait: every later step checks it still has that createdAt.
    const entry = SandboxInstance.readForReset(sandboxName, wait);
    entry.catch(() => undefined);
    const reset = await SandboxInstance.resetOnControlPlane(sandboxName, entry, uuidv4(), wait);
    if (reset) {
      const instance = await SandboxInstance.attachH2Session(new SandboxInstance(reset));
      return SandboxInstance.waitUntilAnswering(sandboxName, instance, wait);
    }
    return SandboxInstance.resetBySwitching(sandboxName, await entry, wait);
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

  // Ask the control plane to replace the sandbox's instance. Answers the
  // sandbox once its new instance runs, or nothing when the control plane has
  // no such call, for the reset to switch the sandbox off and on instead. An
  // answer lost at the edge or on the way is asked for again while there is
  // time, with the same Idempotency-Key: a control plane that already ran the
  // reset, or is still running it, answers with the sandbox instead of
  // replacing its instance a second time. The call goes by name, so it is
  // asked for again only while the name still holds the sandbox the reset is
  // for.
  private static async resetOnControlPlane(sandboxName: string, entry: Promise<SandboxModel>, idempotencyKey: string, wait: ResetWait): Promise<SandboxModel | undefined> {
    for (let attempt = 1; ; attempt++) {
      let status: number | undefined;
      let failure: unknown;
      if (attempt > 1) await SandboxInstance.checkStillThere(sandboxName, await entry, wait);
      let reset: SandboxModel | undefined;
      try {
        const { data, error, response } = await withDeadline(remainingMs(wait), (signal) =>
          controlPlaneClient.post<SandboxModel, unknown, false>({
            security: [{ scheme: "bearer", type: "http" }],
            url: "/sandboxes/{sandboxName}/reset",
            path: { sandboxName },
            headers: { "Idempotency-Key": idempotencyKey },
            signal,
          }),
        );
        if (resetsBySwitching(response.status, error)) return undefined;
        if (response.ok && data) reset = data;
        status = response.status;
        failure = error ?? { code: response.status, error: response.statusText };
      } catch (e) {
        if (isAbort(e)) {
          throw new Error(
            `Sandbox ${sandboxName} was not reset within ${wait.seconds}s; a reset the control plane started still finishes, so the sandbox may yet get its fresh instance`,
            { cause: e },
          );
        }
        if (!isTransientResetError(e)) throw e;
        failure = e;
      }
      if (reset) {
        const started = await entry.catch(() => undefined);
        if (started && reset.metadata.createdAt !== started.metadata.createdAt) {
          throw new ResetGenerationError(`Sandbox ${sandboxName} was deleted and created again as its reset started; the new sandbox was reset`);
        }
        return reset;
      }
      const retryable = status === undefined || GATEWAY_ERROR_STATUSES.has(status);
      if (!retryable) throw failure;
      const delay = backoffDelayMs(attempt, 200, 2000);
      if (Date.now() + delay >= wait.deadline) {
        throw new Error(`Sandbox ${sandboxName} could not be reset within ${wait.seconds}s: ${describeApiError(failure)}`, { cause: failure });
      }
      await sleep(delay);
    }
  }

  // Before a reset call is sent again: the sandbox must still be the one the
  // reset is for. The call whose answer was lost may have reached a sandbox
  // created again under the name, which is not reset a second time.
  private static async checkStillThere(sandboxName: string, entry: SandboxModel, wait: ResetWait) {
    const record = await SandboxInstance.readForReset(sandboxName, wait).catch((e: unknown) => {
      if (isSandboxNotFound(e)) throw new ResetGenerationError(`Sandbox ${sandboxName} was deleted during its reset`, e);
      throw e;
    });
    if (record.metadata.createdAt !== entry.metadata.createdAt) {
      throw new ResetGenerationError(
        `Sandbox ${sandboxName} was deleted and created again during its reset; the reset call whose answer was lost may have reached the new sandbox, which is not reset again`,
      );
    }
  }

  // Wait until the sandbox answers on its new instance. The control plane
  // answers once the instance runs; the gateway can take a moment more to
  // route to it.
  private static async waitUntilAnswering(sandboxName: string, instance: SandboxInstance, wait: ResetWait): Promise<SandboxInstance> {
    for (;;) {
      const answer = await SandboxInstance.probe(sandboxName, instance, wait);
      if (answer === true) return instance;
      if (Date.now() + wait.interval >= wait.deadline) {
        throw new Error(`Sandbox ${sandboxName} has a fresh instance but it did not answer within ${wait.seconds}s after the reset: ${answer}`);
      }
      await sleep(wait.interval);
    }
  }

  // One call to the sandbox's health route, cut at the reset's deadline: true
  // when it answers, or why not yet. The gateway answers 404
  // (WORKLOAD_UNAVAILABLE) while no instance is routable, and an edge error, a
  // dropped connection or a call that ran out of time say nothing yet.
  // Anything else is an answer the reset cannot read, and is thrown.
  private static async probe(sandboxName: string, instance: SandboxInstance, wait: ResetWait): Promise<true | string> {
    try {
      const { response, error } = await withDeadline(Math.min(remainingMs(wait), RESET_PROBE_TIMEOUT_MS), (signal) =>
        getHealth({ baseUrl: instance.system.url, client: instance.system.client, signal }),
      );
      if (response.ok) return true;
      if (response.status === 404 || GATEWAY_ERROR_STATUSES.has(response.status)) {
        return `${response.status} ${describeApiError(error ?? response.statusText)}`;
      }
      throw new Error(`Sandbox ${sandboxName} answered ${response.status} after the reset: ${describeApiError(error ?? response.statusText)}`);
    } catch (e) {
      if (isAbort(e) || isTransientResetError(e)) return describeApiError(e);
      throw e;
    }
  }

  // Reset a sandbox on a control plane without the reset call: switch it off,
  // wait until the platform reports its instance gone, switch it back on and
  // wait until it is deployed again and answers. Every write is preceded by a
  // fresh read of the record, and refused unless the sandbox is still the one
  // being reset and still in a state the write is meant for.
  private static async resetBySwitching(sandboxName: string, current: SandboxModel, wait: ResetWait): Promise<SandboxInstance> {
    const status = current.status ?? "";
    if (!RESETTABLE_STATUSES.has(status)) {
      throw new Error(`Sandbox ${sandboxName} is ${status || "in an unknown state"} and cannot be reset`);
    }
    if (current.spec.enabled !== false && !RESET_ENTRY_OFF_STATUSES.has(status)) {
      let off: SandboxModel;
      try {
        off = await SandboxInstance.writeEnabled(sandboxName, current, current, false, wait);
      } catch (e) {
        if (e instanceof ResetGenerationError) throw e;
        throw new Error(`Sandbox ${sandboxName} could not be reset, it was left as it was: ${describeApiError(e)}`, { cause: e });
      }
      // Writing it back on only redeploys a sandbox that was really taken down.
      if (off.spec.enabled !== false || !RESET_ENTRY_OFF_STATUSES.has(off.status ?? "")) {
        throw new Error(`Sandbox ${sandboxName} could not be reset: the control plane did not take it down (it is ${off.status})`);
      }
    }
    const stopped = await SandboxInstance.waitForTeardown(sandboxName, current, wait);
    try {
      await SandboxInstance.writeEnabled(sandboxName, current, stopped, true, wait);
    } catch (e) {
      if (e instanceof ResetGenerationError) throw e;
      throw new Error(
        `Sandbox ${sandboxName} was taken down for the reset but could not be switched back on, ${leftOff(sandboxName)}: ${describeApiError(e)}`,
        { cause: e },
      );
    }
    return SandboxInstance.waitForRedeploy(sandboxName, current, wait);
  }

  // Read the sandbox's record within the reset's deadline. A read is
  // idempotent, so a dropped connection or an edge error is read again while
  // there is time; anything else, a missing sandbox above all, is thrown as
  // the control plane answered it.
  private static async readForReset(sandboxName: string, wait: ResetWait): Promise<SandboxModel> {
    for (let attempt = 1; ; attempt++) {
      try {
        const { data } = await withDeadline(remainingMs(wait), (signal) =>
          getSandbox({ path: { sandboxName }, throwOnError: true, signal }),
        );
        return data;
      } catch (e) {
        if (isAbort(e)) throw new Error(`Sandbox ${sandboxName} could not be read within the ${wait.seconds}s of its reset`, { cause: e });
        const delay = backoffDelayMs(attempt, 200, 2000);
        if (!isTransientResetError(e) && !isGatewayBody(e)) throw e;
        if (Date.now() + delay >= wait.deadline) throw e;
        await sleep(delay);
      }
    }
  }

  // Write the sandbox back with spec.enabled set, from the record as the
  // control plane last returned it: the values of secret environment
  // variables come back masked and are kept as stored. A write that failed
  // on the way is written again within the deadline, from a fresh read and
  // only if that read is still the sandbox being reset, in the state the
  // write is meant for; one that landed before its answer was lost is not
  // written twice. A write that landed on a sandbox created again under the
  // same name is reported, since it cannot be taken back.
  private static async writeEnabled(sandboxName: string, entry: SandboxModel, record: SandboxModel, enabled: boolean, wait: ResetWait): Promise<SandboxModel> {
    let body = record;
    for (let attempt = 1; ; attempt++) {
      if (attempt > 1) {
        body = await SandboxInstance.readForReset(sandboxName, wait).catch((e: unknown) => {
          if (isSandboxNotFound(e)) throw new ResetGenerationError(`Sandbox ${sandboxName} was deleted during its reset`, e);
          throw e;
        });
        // The write goes by name: one whose answer was lost may have reached
        // a sandbox created again under it.
        if (body.metadata.createdAt !== entry.metadata.createdAt) {
          throw new ResetGenerationError(
            `Sandbox ${sandboxName} was deleted and created again during its reset; the reset's ${enabled ? "switch-on" : "switch-off"} write whose answer was lost may have reached the new sandbox, which is left as it is now`,
          );
        }
        if ((body.spec.enabled !== false) === enabled) return body;
        const expected = enabled ? RESET_ENTRY_OFF_STATUSES : RESETTABLE_STATUSES;
        if (!expected.has(body.status ?? "")) {
          throw new ResetGenerationError(`Sandbox ${sandboxName} is ${body.status} while it should be ${enabled ? "switched off" : "running"} for the reset; it is left as it is`);
        }
      }
      let data: SandboxModel;
      try {
        ({ data } = await withDeadline(remainingMs(wait), (signal) =>
          updateSandbox({
            path: { sandboxName },
            body: { metadata: body.metadata, spec: { ...body.spec, enabled } } as SandboxModel,
            throwOnError: true,
            signal,
          }),
        ));
      } catch (e) {
        if (isAbort(e)) throw new Error(`no answer within the ${wait.seconds}s of the reset`, { cause: e });
        const delay = backoffDelayMs(attempt, 200, 2000);
        if (!isTransientResetError(e) && !isGatewayBody(e)) throw e;
        if (Date.now() + delay >= wait.deadline) throw e;
        await sleep(delay);
        continue;
      }
      if (data.metadata.createdAt !== entry.metadata.createdAt) {
        throw new ResetGenerationError(
          `Sandbox ${sandboxName} was deleted and created again while it was being switched ${enabled ? "back on" : "off"} for its reset; the new sandbox was written to and is left switched ${enabled ? "on" : "off"}`,
        );
      }
      return data;
    }
  }

  // Wait until the platform reports the switched-off instance gone, and answer
  // the record read last, the one the switch-on is written from. Switched back
  // on while the old instance still runs, the sandbox could keep it. The
  // record says when it is gone: the deployment pipeline writes a succeeded
  // deployment once it has taken the instance down. Nothing the old guest
  // answers is taken as a sign of it.
  private static async waitForTeardown(sandboxName: string, entry: SandboxModel, wait: ResetWait): Promise<SandboxModel> {
    for (;;) {
      let record: SandboxModel;
      try {
        record = await SandboxInstance.readForReset(sandboxName, wait);
      } catch (e) {
        if (isSandboxNotFound(e)) throw new Error(`Sandbox ${sandboxName} was deleted during its reset`, { cause: e });
        throw new Error(`Sandbox ${sandboxName} is switched off for the reset, but it could not be read again, ${leftOff(sandboxName)}: ${describeApiError(e)}`, { cause: e });
      }
      checkSameSandbox(sandboxName, entry, record);
      if (!RESET_ENTRY_OFF_STATUSES.has(record.status ?? "") || record.spec.enabled !== false) {
        throw new Error(`Sandbox ${sandboxName} is ${record.status} while it should be switched off for the reset; it is left as it is`);
      }
      const teardown = teardownState(record);
      if (teardown === "done") return record;
      if (teardown === "failed") {
        throw new Error(
          `Sandbox ${sandboxName} could not be taken down for the reset: the platform reported the teardown failed. It is left switched off; delete it and create it again to get a fresh instance`,
        );
      }
      if (Date.now() + wait.interval >= wait.deadline) {
        throw new Error(`Sandbox ${sandboxName} is switched off for the reset, but its old instance was not reported gone within ${wait.seconds}s, ${leftOff(sandboxName)}`);
      }
      await sleep(wait.interval);
    }
  }

  // Wait until the sandbox is DEPLOYED again and answers. The record turns
  // DEPLOYED a moment before the sandbox is routable, so DEPLOYED alone is not
  // ready.
  private static async waitForRedeploy(sandboxName: string, entry: SandboxModel, wait: ResetWait): Promise<SandboxInstance> {
    const entryDeadline = Math.min(Date.now() + RESET_ENTRY_MAX_WAIT_MS, wait.deadline);
    let redeploying = false;
    for (;;) {
      await sleep(wait.interval);
      const record = await SandboxInstance.readForReset(sandboxName, wait);
      checkSameSandbox(sandboxName, entry, record);
      if (record.status === "DEPLOYED") {
        const instance = await SandboxInstance.attachH2Session(new SandboxInstance(record));
        return SandboxInstance.waitUntilAnswering(sandboxName, instance, wait);
      }
      if (record.status === "FAILED") {
        throw new Error(`Sandbox ${sandboxName} failed to deploy again after the reset`);
      }
      if (record.status === "DEPLOYING") {
        redeploying = true;
      } else if (redeploying || !RESET_ENTRY_OFF_STATUSES.has(record.status ?? "") || Date.now() >= entryDeadline) {
        throw new Error(`Sandbox ${sandboxName} is ${record.status} while it should be deployed again after the reset`);
      }
      if (Date.now() + wait.interval >= wait.deadline) {
        throw new Error(`Sandbox ${sandboxName} is still ${record.status} after waiting ${wait.seconds}s for it to deploy again after the reset`);
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
