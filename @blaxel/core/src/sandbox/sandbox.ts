import type http2 from "http2";
import { archiveSandbox, createSandbox, createSandboxSnapshot, deleteSandbox, deleteSandboxSnapshot, type Env, forkSandbox, getSandbox, getSandboxByExternalId, listSandboxes, listSandboxSnapshots, type ListSandboxesData, restoreSandboxSnapshot, type SandboxForkResponse, type SandboxLifecycle, type Sandbox as SandboxModel, type SandboxRestoreResponse, type SandboxSnapshot, unarchiveSandbox, updateSandbox } from "../client/index.js";
import { logger } from "../common/logger.js";
import { pollDelayMs } from "../common/polling.js";
import { backoffDelayMs } from "../common/transient-retry.js";
import { createPaginatedList } from "../common/pagination.js";
import { settings } from "../common/settings.js";
import { SandboxCodegen } from "./codegen/index.js";
import { SandboxDrive } from "./drive/index.js";
import { describeDrift, driftWarning, type RequestedSandbox } from "./drift.js";
import { SandboxFileSystem } from "./filesystem/index.js";
import { SandboxNetwork } from "./network/index.js";
import { SandboxPreviews } from "./preview.js";
import { SandboxProcess } from "./process/index.js";
import { SandboxDriveSetup, validateMountDrives } from "./mount-drives.js";
import { invalidSandboxNameHint } from "./names.js";
import { SandboxSchedules } from "./schedule.js";
import { SandboxSnapshotsResource } from "./snapshot.js";
import { SandboxSessions } from "./session.js";
import { SandboxSystem } from "./system.js";
import { normalizeEnvs, normalizePorts, normalizeVolumes, SandboxConfiguration, SandboxCreateConfiguration, SandboxDriveMountConfiguration, SandboxUpdateMetadata, SandboxUpdateNetwork, SessionWithToken } from "./types.js";

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

/** How long to wait for an archive, or its restore, to finish. */
export type SandboxArchiveOptions = {
  /** Wait for the archive/restore to finish. Defaults to true. */
  wait?: boolean;
  /** Give up after this many milliseconds. Defaults to 30 minutes. */
  maxWait?: number;
  /**
   * Milliseconds before the second read of the sandbox. Defaults to 2 seconds.
   * Later reads back off with jitter up to 30 seconds (or `interval` if larger).
   */
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
  /**
   * Drives to mount on the sandbox. Drives are looked up or created while the
   * sandbox is being created (a few at a time), in the region the request sends
   * (or, without one, in the region the sandbox gets), and each is mounted as
   * soon as the sandbox and that drive are ready. On failure, unnamed drives
   * this call created and did not mount are deleted; named ones are kept (a
   * concurrent call may be using them) and listed in the error. If drive setup
   * fails the sandbox is kept and a SandboxDriveSetupError is thrown; if the
   * sandbox cannot be created, its error is thrown (wrapped in a
   * SandboxDriveSetupError only if a drive created for it is left in place).
   */
  mountDrives?: SandboxDriveMountConfiguration[];
};

export { SandboxDriveSetupError } from "./mount-drives.js";

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

// A creation the control plane rejects at its credential check, in a way a new
// attempt can fix: a generic 403 "Authorization failed" (code UNAUTHORIZED) when
// it could not resolve the credentials, or a 503 AUTHENTICATION_UNAVAILABLE when
// its credential store is unreachable. Both are answered before anything is
// created, so sending the same request again is safe. A revoked token (401
// TOKEN_REVOKED) or a missing workspace permission (UNAUTHORIZED_WORKSPACE) is
// final and is not retried. A key the API does not recognize gets the same
// 403, so the retries stay few and the final message asks to check the key.
export const CREATE_AUTH_RETRIES = 2;
const CREATE_AUTH_RETRY_BASE_DELAY_MS = 500;
const CREATE_AUTH_RETRY_MAX_DELAY_MS = 2_000;

const errorCode = (e: unknown): unknown =>
  typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;

const isTransientCreateAuthFailure = (status: number | undefined, e: unknown): boolean =>
  (status === 403 && errorCode(e) === "UNAUTHORIZED") ||
  (status === 503 && errorCode(e) === "AUTHENTICATION_UNAVAILABLE");

const QUOTAS_DOC_URL = "https://docs.blaxel.ai/Security/Quotas";

// Seconds a Retry-After header asks to wait (delta-seconds or an HTTP date).
function retryAfterSeconds(headers: Headers | undefined, now = Date.now()): number | undefined {
  const value = headers?.get("retry-after")?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

// A 403 the API itself did not answer: no JSON error body. That is an empty
// or non-JSON body (an edge block can return an HTML page), possibly with the
// line the authentication interceptor appends, or an empty JSON object holding
// only the `documentation` field that interceptor adds.
const isNonApiErrorBody = (e: unknown): boolean => {
  if (e === undefined || e === null || typeof e === "string") return true;
  return typeof e === "object" && Object.keys(e).every((key) => key === "documentation");
};

const EDGE_BLOCKED_MESSAGE =
  "HTTP 403 without a JSON error body: likely an edge rate limit or firewall block in front of the API. " +
  "If you send many requests, slow down and retry after about 60 s. " +
  "Blaxel quota and permission errors carry a JSON error code";

const RATE_LIMIT_REASONS: Record<string, string> = {
  WORKSPACE_RATE_LIMIT_EXCEEDED: "too many creations in flight in this workspace",
  RATE_LIMIT_EXCEEDED: "the region's creation rate limit was reached",
};

// The error a rejected creation is thrown with: the API's error body, with a
// message that says what to do for the failures callers can act on. Quota and
// rate-limit errors need opposite handling: QUOTA_EXCEEDED (HTTP 429 for a
// workspace quota, 400 for one ephemeral volume over the per-volume maximum)
// stays until quota is freed or raised; the rate-limit codes clear on their
// own. `retryable` says which; the SDK itself retries none of them.
function createError(response: Response | undefined, e: unknown, sandboxName: string | undefined, attempts: number): unknown {
  const status = response?.status;
  if (status === 403 && isNonApiErrorBody(e)) {
    return { message: EDGE_BLOCKED_MESSAGE, status_code: 403 };
  }
  if (typeof e !== "object" || e === null) return e;
  const body = e as { message?: unknown; code?: unknown; retry_after?: unknown };
  const message = typeof body.message === "string" ? body.message : "";
  if ((status === 429 || status === 400) && body.code === "QUOTA_EXCEEDED") {
    const advice =
      status === 400
        ? "not retryable as is; request a smaller volume or raise the quota"
        : "not retryable until quota is freed or raised";
    return {
      ...body,
      retryable: false,
      message: `${message || "Quota exceeded"} (HTTP ${status} QUOTA_EXCEEDED: ${advice}: ${QUOTAS_DOC_URL})`,
    };
  }
  if (status === 429 && typeof body.code === "string" && body.code in RATE_LIMIT_REASONS) {
    const wait =
      typeof body.retry_after === "number" && body.retry_after >= 0
        ? body.retry_after
        : retryAfterSeconds(response?.headers);
    return {
      ...body,
      retryable: true,
      ...(wait !== undefined ? { retry_after: wait } : {}),
      message:
        `${message || "Rate limit exceeded"} (HTTP 429 ${body.code}: ${RATE_LIMIT_REASONS[body.code]}; ` +
        `${wait !== undefined ? `retry after ${wait} s` : "retry with backoff"})`,
    };
  }
  if (status === 403 && body.code === "UNAUTHORIZED") {
    let workspace = "";
    try {
      workspace = settings.workspace;
    } catch {
      // No credentials resolved: leave the workspace out of the message.
    }
    const current = workspace ? `; current workspace: '${workspace}'` : "";
    return {
      ...body,
      message:
        `${message || "Authorization failed"} (HTTP 403 ${String(body.code)}, after ${attempts} attempts). ` +
        "The API answers this way both for a key it does not recognize and when its credential check fails for a moment. " +
        `Check the credentials and workspace the SDK uses (BL_API_KEY and BL_WORKSPACE, or \`bl login\`${current}); if they are right, retry in a few seconds.`,
    };
  }
  if (status === 400) {
    const hint = invalidSandboxNameHint(sandboxName);
    if (hint) {
      const sentence = message && !/[.!?]$/.test(message) ? `${message}.` : message;
      return { ...body, message: sentence ? sentence + hint : hint.trim() };
    }
  }
  return e;
}

// Without a region the control plane picks one; say so once per process
// instead of on every create.
let regionNoticeShown = false;

function notifyRegionUnset() {
  if (regionNoticeShown) return;
  regionNoticeShown = true;
  console.warn(
    "SandboxInstance.create: no region set, so the platform picks one for the sandbox. " +
    "Set 'region' in the sandbox configuration or the BL_REGION environment variable (e.g. 'us-pdx-1', 'eu-lon-1', 'us-was-1') to choose it; " +
    "'region' will become required in a future version. This notice is shown once per process."
  );
}

/**
 * A Blaxel sandbox: a lightweight VM that runs commands, holds files and
 * serves ports. It scales to zero when idle and resumes with its memory,
 * processes and filesystem intact.
 *
 * Get one with the static methods (`create`, `createIfNotExists`, `get`,
 * `list`), then work inside it through its subsystems: `fs` for files,
 * `process` for commands, `previews` and `sessions` for URLs, `drives` for
 * drive mounts, `snapshots`, `schedules`, `network`, `codegen` and `system`.
 * Authentication comes from the environment (`BL_WORKSPACE` and
 * `BL_API_KEY`) or from the Blaxel CLI login in `~/.blaxel/config.yaml`.
 *
 * @example
 * ```typescript
 * import { SandboxInstance } from "@blaxel/core";
 *
 * const sandbox = await SandboxInstance.createIfNotExists({
 *   name: "my-sandbox",
 *   image: "blaxel/base-image:latest",
 *   memory: 4096,
 *   region: "us-pdx-1",
 *   lifecycle: { expirationPolicies: [{ type: "ttl-idle", value: "30m", action: "delete" }] },
 * });
 *
 * await sandbox.fs.write("/app/hello.txt", "Hello, world");
 * const result = await sandbox.process.exec({
 *   command: "cat /app/hello.txt",
 *   waitForCompletion: true,
 * });
 * console.log(result.exitCode, result.stdout);
 *
 * await sandbox.delete();
 * ```
 */
export class SandboxInstance {
  /** Files: read, write, list, search, watch and copy files in the sandbox. */
  fs: SandboxFileSystem;
  /** Call a server listening on a sandbox port. */
  network: SandboxNetwork;
  /** Commands: run, wait for, stream the logs of and stop processes in the sandbox. */
  process: SandboxProcess;
  /** Public or token-protected URLs that expose a sandbox port. */
  previews: SandboxPreviews;
  /** Commands the platform runs in the sandbox on a cron schedule, at a set time or after a delay. */
  schedules: SandboxSchedules;
  /** Short-lived URLs and tokens to reach the sandbox API without an API key. */
  sessions: SandboxSessions;
  /** AI-assisted code edits and file ranking (needs a provider key in the sandbox). */
  codegen: SandboxCodegen;
  /** Maintenance of the sandbox API itself, such as upgrades. */
  system: SandboxSystem;
  /** Mount and unmount drives inside the sandbox. */
  drives: SandboxDrive;
  /** Create, list, get, restore and delete the snapshots captured from this sandbox. */
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

  /** Name, display name, labels, external ID and URL of the sandbox. */
  get metadata() {
    return this.sandbox.metadata;
  }

  /**
   * Deployment status when this instance was read, such as `DEPLOYING`,
   * `DEPLOYED`, `FAILED`, `ARCHIVED` or `TERMINATED`. It is not refreshed:
   * call `SandboxInstance.get()` for the current value.
   */
  get status() {
    return this.sandbox.status;
  }

  /** Lifecycle events recorded for the sandbox. */
  get events() {
    return this.sandbox.events;
  }

  /** Configuration of the sandbox: region, runtime (image, memory, ports, envs, ttl), volumes, lifecycle and network. */
  get spec() {
    return this.sandbox.spec;
  }

  /** When the sandbox was last used, as recorded by the platform when this instance was read. */
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

  /** Edge domain the HTTP/2 connection to this sandbox goes through, or null when HTTP/2 is not used. */
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

  /**
   * Seconds until the sandbox is deleted by its TTL and lifecycle policies,
   * as of when this instance was read. Undefined when none is configured.
   */
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
  /**
   * Does nothing but log a warning and return this sandbox: `create()`
   * resolves once the sandbox can be used.
   *
   * @deprecated No longer needed; remove the call.
   */
  async wait({ maxWait = 60000, interval = 1000 }: { maxWait?: number, interval?: number } = {}) {
    logger.warn("⚠️  Warning: sandbox.wait() is deprecated. You don't need to wait for the sandbox to be deployed anymore.");
    return this;
  }

  /**
   * Create a sandbox and return it once it is ready to use.
   *
   * Pass the shorthand `SandboxCreateConfiguration` (`name`, `image`,
   * `memory`, `region`, `envs`, `ports`, `ttl`, `lifecycle`, ...) or a full
   * `Sandbox` model. Unset fields get the SDK defaults: image
   * `blaxel/base-image:latest`, 4096 MB of memory and the region from
   * `BL_REGION` (without one, the platform picks the region). Without a name
   * the platform assigns one.
   *
   * Names are lowercase letters, digits and single hyphens, at most
   * SANDBOX_NAME_MAX_LENGTH (49) characters, like `my-sandbox-1`; other names,
   * and lifecycle durations under the minimums (`ttl` and `ttl-max-age` 5m,
   * `ttl-idle` 60s), are rejected with HTTP 400. The SDK never renames a
   * sandbox: to name one after an external id such as `sesn_01AbC`, pass the id
   * through `sanitizeSandboxName` first (`isValidSandboxName` checks a name). A
   * name already held by a live sandbox is rejected with HTTP 409: use
   * `createIfNotExists()` to get that sandbox back instead.
   *
   * A creation rejected by a transient authentication failure (403
   * `UNAUTHORIZED` or 503 `AUTHENTICATION_UNAVAILABLE`, both answered before
   * anything is created) is sent again up to CREATE_AUTH_RETRIES times with a
   * short backoff.
   *
   * @param sandbox - Shorthand configuration or full `Sandbox` model. Optional: all defaults apply when omitted.
   * @param options - `timeout` (whole seconds, 1 to 50) to cancel a creation that takes too long, `safe` (default false) to check the sandbox answers and delete it if it does not, and `mountDrives` to mount drives as part of the creation.
   * @returns The new sandbox.
   * @throws SandboxCreationTimeoutError when `timeout` elapses before the sandbox is ready; the name is free again.
   * @see https://docs.blaxel.ai/Sandboxes/Lifecycle-recipe for choosing between ttl, ttl-idle, ttl-max-age and date policies.
   *
   * @example
   * ```typescript
   * const sandbox = await SandboxInstance.create({
   *   name: "build-42",
   *   image: "blaxel/base-image:latest",
   *   memory: 8192,
   *   region: "us-pdx-1",
   *   envs: [{ name: "NODE_ENV", value: "production" }],
   *   ports: [{ name: "web", target: 3000 }],
   *   ttl: "2h",
   * });
   * ```
   */
  static async create(sandbox?: SandboxModel | SandboxCreateConfiguration, options: SandboxCreateOptions = {}) {
    const { mountDrives = [], createIfNotExist = false } = options;
    validateCreateOptions(options);
    validateMountDrives(mountDrives, createIfNotExist);
    const { model, requested } = SandboxInstance.toSandboxModel(sandbox);
    if (!mountDrives.length) return SandboxInstance.createSandboxInstance(model, requested, options);
    // Drives are set up alongside the sandbox, in the region this request sends (if it
    // sends none, the control plane picks one and new drives wait for the sandbox).
    const drives = new SandboxDriveSetup(mountDrives, model.spec?.region);
    drives.start();
    let instance: SandboxInstance;
    try {
      instance = await SandboxInstance.createSandboxInstance(model, requested, options);
    } catch (err) {
      throw await drives.discard(err);
    }
    await drives.mount(instance);
    return instance;
  }

  /**
   * The creation request body, with the SDK's defaults (image, memory, region from BL_REGION) applied,
   * plus what the caller explicitly asked for (before defaults).
   */
  private static toSandboxModel(sandbox?: SandboxModel | SandboxCreateConfiguration): { model: SandboxModel; requested: RequestedSandbox } {
    // No client-side default name: when the caller omits a name we send the
    // creation without metadata.name so the server can assign one and unnamed
    // creations become eligible for warm sandbox pools (ENG-3931).
    const defaultImage = `blaxel/base-image:latest`
    const defaultMemory = 4096

    // What the caller asked for, read before the defaults below fill the gaps:
    // createIfNotExists compares only these with the sandbox it gets back.
    let requested: RequestedSandbox = {}

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
      'extraArgs' in sandbox ||
      'terminationGracePeriodSeconds' in sandbox ||
      'standbyGracePeriodSeconds' in sandbox ||
      'dockerConfig' in sandbox
    ) {
      if (!sandbox) sandbox = {} as SandboxCreateConfiguration
      requested = { image: sandbox.image, memory: sandbox.memory, region: sandbox.region, envs: normalizeEnvs(sandbox.envs) }
      if (!sandbox.image) sandbox.image = defaultImage
      if (!sandbox.memory) sandbox.memory = defaultMemory

      const ports = normalizePorts(sandbox.ports);
      const envs = normalizeEnvs(sandbox.envs);
      const volumes = normalizeVolumes(sandbox.volumes);
      const ttl = sandbox.ttl;
      const expires = sandbox.expires;
      const region = sandbox.region || settings.region;
      if (!region) notifyRegionUnset();
      const lifecycle = sandbox.lifecycle;
      const network = sandbox.network;
      const snapshotEnabled = sandbox.snapshotEnabled;
      const extraArgs = sandbox.extraArgs;
      const { terminationGracePeriodSeconds, standbyGracePeriodSeconds } = sandbox;
      // Not in the generated SandboxRuntime: the API reads it from the raw body, like the CLI sends it.
      const dockerConfig = typeof sandbox.dockerConfig === "object" ? JSON.stringify(sandbox.dockerConfig) : sandbox.dockerConfig;

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
            terminationGracePeriodSeconds,
            standbyGracePeriodSeconds,
            dockerConfig,
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
    } else {
      const { region, runtime } = (sandbox as SandboxModel).spec ?? {}
      requested = { image: runtime?.image, memory: runtime?.memory, region, envs: runtime?.envs }
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
    return { model: sandbox, requested };
  }

  private static async createSandboxInstance(sandbox: SandboxModel, requested: RequestedSandbox, options: SandboxCreateOptions) {
    const { safe = false, createIfNotExist = false } = options;
    const { timeout } = validateCreateOptions(options);
    const edgeDomain = SandboxInstance.edgeDomainForRegion(sandbox.spec?.region);

    // Kick off warming so h2Pool.get() can join it during the API call
    if (edgeDomain && !settings.disableH2) {
      import("../common/h2pool.js").then(({ h2Pool }) => h2Pool.warm(edgeDomain)).catch(() => { });
    }

    const headers = timeout !== undefined ? { [CREATION_TIMEOUT_HEADER]: String(timeout) } : undefined;
    const [{ result: createResult, attempts }, h2Session] = await Promise.all([
      SandboxInstance.sendCreate(sandbox, createIfNotExist, headers),
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
        throw createError(createResult.response, createResult.error, name, attempts);
      }
    }
    if (createIfNotExist) SandboxInstance.warnOnDrift(requested, data)
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
    let attempt = 0;
    for (;;) {
      // Until the operation is seen pending, read at the first interval: a
      // backed-off sleep could pass the entry grace window or miss a short
      // pending status.
      if (started) {
        attempt++;
      }
      const remaining = Math.max(deadline - Date.now(), 0);
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollDelayMs(Math.max(attempt, 1), interval), remaining)));
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

  /**
   * Get an existing sandbox by name, with its current status and configuration.
   *
   * @param sandboxName - Name of the sandbox.
   * @returns The sandbox, ready for `fs`, `process` and the other subsystems.
   * @throws When no sandbox has this name in the workspace (HTTP 404).
   *
   * @example
   * ```typescript
   * const sandbox = await SandboxInstance.get("my-sandbox");
   * console.log(sandbox.status, sandbox.spec.runtime?.image);
   * const files = await sandbox.fs.ls("/app");
   * ```
   */
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

  /**
   * Get the most recent sandbox that is not terminated and carries this
   * external ID (set with `externalId` on creation or `updateMetadata()`).
   *
   * @param externalId - The caller-owned identifier.
   * @returns The matching sandbox.
   * @throws When no active sandbox has this external ID (HTTP 404).
   */
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

  /**
   * Permanently delete a sandbox with its memory and filesystem. This cannot
   * be undone; attached volumes are kept.
   *
   * @param sandboxName - Name of the sandbox to delete.
   * @returns The deleted sandbox record.
   */
  static async delete(sandboxName: string) {
    const { data } = await deleteSandbox({
      path: {
        sandboxName,
      },
      throwOnError: true,
    });
    return data;
  }

  /**
   * Permanently delete this sandbox. This cannot be undone; attached volumes
   * are kept.
   *
   * @returns The deleted sandbox record.
   * @see SandboxInstance.delete
   */
  async delete() {
    // Don't close the H2 session — it's shared via h2Pool
    this.h2Session = null;
    this.sandbox.h2Session = null;
    this.sandbox.h2Domain = null;
    return await SandboxInstance.delete(this.metadata.name!);
  }

  /**
   * Change the display name, labels or external ID of a sandbox. The name
   * itself cannot change.
   *
   * Reads the sandbox, then writes it back with the change: two updates of
   * the same sandbox at the same time can overwrite each other.
   *
   * @param sandboxName - Name of the sandbox.
   * @param metadata - Fields to change. `labels` replaces the whole label map, so include the labels to keep.
   * @returns The updated sandbox.
   */
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

  /**
   * Set or remove the maximum age (`spec.runtime.ttl`) of a sandbox: it is
   * deleted this long after it was created, whether it is active or not.
   *
   * Reads the sandbox, then writes it back with the change: two updates of
   * the same sandbox at the same time can overwrite each other.
   *
   * @param sandboxName - Name of the sandbox.
   * @param ttl - Duration with unit s, m, h, d or w (for example `"30m"`, `"24h"`, `"7d"`), minimum `"5m"`; a shorter value is rejected with HTTP 400. `null` or `""` removes the TTL.
   * @returns The updated sandbox.
   * @see https://docs.blaxel.ai/Sandboxes/Lifecycle-recipe for choosing between ttl, ttl-idle, ttl-max-age and date policies.
   *
   * @example
   * ```typescript
   * await SandboxInstance.updateTtl("my-sandbox", "24h");
   * ```
   */
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

  /**
   * Replace the lifecycle (automatic deletion rules) of a sandbox.
   *
   * Each expiration policy needs `action: "delete"` and a `type`: `ttl-idle`
   * deletes the sandbox after that long without activity (minimum `"60s"`),
   * `ttl-max-age` that long after creation (minimum `"5m"`), and `date` at an
   * ISO 8601 time in the future. Shorter durations are rejected with HTTP
   * 400. Each type may appear once; the first condition met triggers the
   * deletion. `terminatedRetention` (default `"5m"`) keeps the record of a
   * terminated sandbox, for its logs, that long. A lifecycle needs at least
   * one policy or a `terminatedRetention`.
   *
   * Reads the sandbox, then writes it back with the change: two updates of
   * the same sandbox at the same time can overwrite each other.
   *
   * @param sandboxName - Name of the sandbox.
   * @param lifecycle - The new lifecycle, or `null` to remove it.
   * @returns The updated sandbox.
   * @see https://docs.blaxel.ai/Sandboxes/Lifecycle-recipe for choosing between ttl, ttl-idle, ttl-max-age and date policies.
   *
   * @example
   * ```typescript
   * await SandboxInstance.updateLifecycle("my-sandbox", {
   *   expirationPolicies: [
   *     { type: "ttl-idle", value: "30m", action: "delete" },
   *     { type: "ttl-max-age", value: "7d", action: "delete" },
   *   ],
   * });
   * ```
   */
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


  /**
   * Replace the network configuration of a sandbox (egress gateway, firewall
   * rulesets, proxy and allowed or forbidden domains).
   *
   * Reads the sandbox, then writes it back with the change: two updates of
   * the same sandbox at the same time can overwrite each other.
   *
   * @param sandboxName - Name of the sandbox.
   * @param network - `{ network }`, the configuration that replaces the current one.
   * @returns The updated sandbox.
   */
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
   *
   * A sandbox in standby counts as alive: it is returned and resumes with its
   * memory, processes and files. The existing sandbox keeps its own
   * configuration; the image, memory, region and envs of this request are
   * not applied, and a warning is logged when they differ. Without a `name`,
   * this always creates a new sandbox.
   *
   * @param sandbox - Shorthand configuration or full `Sandbox` model; set a `name` to make the call reuse a sandbox.
   * @param options - Same as `create()` options, except `createIfNotExist`.
   * @returns The existing or newly created sandbox.
   * @see https://docs.blaxel.ai/Sandboxes/Lifecycle-recipe for choosing between ttl, ttl-idle, ttl-max-age and date policies.
   *
   * @example
   * ```typescript
   * // Safe to call on every run: the first call creates, later calls reuse.
   * const sandbox = await SandboxInstance.createIfNotExists({
   *   name: "agent-workspace",
   *   region: "us-pdx-1",
   *   lifecycle: { expirationPolicies: [{ type: "ttl-idle", value: "1h", action: "delete" }] },
   * });
   * ```
   */
  static async createIfNotExists(sandbox: SandboxModel | SandboxCreateConfiguration, options: Omit<SandboxCreateOptions, "createIfNotExist"> = {}) {
    return this.create(sandbox, { ...options, createIfNotExist: true });
  }

  // Send the creation, again after a transient authentication failure (up to
  // CREATE_AUTH_RETRIES more times, with a short backoff).
  private static async sendCreate(body: SandboxModel, createIfNotExist: boolean, headers: Record<string, string> | undefined) {
    for (let attempts = 1; ; attempts++) {
      const result = await createSandbox({
        body,
        query: createIfNotExist ? { createIfNotExist } : undefined,
        headers,
      });
      if (
        result.error === undefined ||
        attempts > CREATE_AUTH_RETRIES ||
        !isTransientCreateAuthFailure(result.response?.status, result.error)
      ) {
        return { result, attempts };
      }
      logger.debug(`Sandbox creation hit a transient authentication failure (HTTP ${result.response?.status}), retrying`);
      await new Promise((resolve) =>
        setTimeout(resolve, backoffDelayMs(attempts, CREATE_AUTH_RETRY_BASE_DELAY_MS, CREATE_AUTH_RETRY_MAX_DELAY_MS)),
      );
    }
  }

  // createIfNotExists hands back the sandbox already holding the name, whatever
  // it was created with. Say so when it is not what was asked for; this only
  // logs and never throws or changes what is returned.
  private static warnOnDrift(requested: RequestedSandbox, existing: SandboxModel | undefined) {
    if (!existing) return;
    try {
      const drift = describeDrift(requested, existing);
      if (drift.length) console.warn(driftWarning(existing.metadata?.name, drift));
    } catch {
      // Best-effort diagnostics: a failed comparison must not fail the create.
    }
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
  /**
   * Reach a sandbox through a session instead of an API key, for example
   * from a browser that received the session from your backend.
   *
   * Requests go to the session URL with its token, so use the subsystems
   * served by the sandbox itself (`fs`, `process`, `network`, `drives`,
   * `codegen`, `system`). Calls that go through the Blaxel API, such as
   * `previews`, `sessions`, `snapshots` or `delete()`, are not bound to the
   * session and need an API key. The session stops working when its token
   * expires.
   *
   * @param session - A session from `sandbox.sessions.create()` or `createIfExpired()`.
   * @returns A sandbox instance bound to the session URL and token. No request is made.
   *
   * @example
   * ```typescript
   * // Backend, with an API key:
   * const session = await sandbox.sessions.createIfExpired();
   * // Frontend, with only the session:
   * const remote = await SandboxInstance.fromSession(session);
   * const out = await remote.process.exec({ command: "ls /app", waitForCompletion: true });
   * ```
   */
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
