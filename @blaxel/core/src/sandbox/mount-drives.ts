import { v4 as uuidv4 } from "uuid";
import { DriveInstance, type DriveCreateConfiguration } from "../drive/index.js";
import type { DriveMountRequest } from "./drive/index.js";
import type { SandboxInstance } from "./sandbox.js";
import type { SandboxDriveMountConfiguration } from "./types.js";

/** Most drive lookups/creations, mounts and deletions in flight at once. */
export const MOUNT_DRIVES_CONCURRENCY = 5;

/**
 * Thrown when `mountDrives` could not be set up. Drives this call created and
 * did not mount are deleted first; `createdDrives` names the ones it created
 * (or may have created, when a response was lost) that are left in place.
 *
 * - `sandbox` is set when the sandbox is ready: it and the mounts made so far
 *   are kept. `driveNames` lists the drives this call looked up or created that
 *   are left in place.
 * - `sandbox` is undefined when the sandbox could not be created (its error is
 *   the `cause`) and some drives created for it could not be deleted. When they
 *   all could, the sandbox's error is thrown as is instead.
 */
export class SandboxDriveSetupError extends Error {
  constructor(
    readonly sandbox: SandboxInstance | undefined,
    readonly driveNames: string[],
    readonly createdDrives: string[],
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : JSON.stringify(cause);
    const left = createdDrives.length ? ` Drives this call created (or may have created) are left in place: ${createdDrives.join(", ")}.` : "";
    super(sandbox
      ? `Sandbox ${sandbox.metadata.name} is ready, but mounting its drives failed: ${detail}.${left}`
      : `Sandbox creation failed: ${detail}.${left}`, { cause });
    this.name = "SandboxDriveSetupError";
  }
}

const cleanPath = (path = "/") => `/${path.split("/").filter(Boolean).join("/")}`;

/** The HTTP status of an API error, if it has one. */
function httpStatus(e: unknown): number | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const error = e as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  for (const value of [error.response?.status, error.status, error.code]) {
    if (typeof value === "number" && value >= 100 && value < 600) return value;
  }
  return undefined;
}

const isConflict = (e: unknown) =>
  httpStatus(e) === 409 || (typeof e === "object" && e !== null && "code" in e && e.code === "DRIVE_ALREADY_EXISTS");

/** The server answered and refused the request, so it changed nothing. Anything else (5xx, network error, timeout) may have gone through. */
function isRejected(e: unknown) {
  const status = httpStatus(e);
  return status !== undefined && status >= 400 && status < 500 && status !== 408;
}

export function validateMountDrives(mounts: SandboxDriveMountConfiguration[], createIfNotExist: boolean) {
  for (const { driveName, create } of mounts) {
    if (!driveName === !create) {
      throw new TypeError("Each mountDrives entry needs exactly one of 'driveName' or 'create'.");
    }
    if (createIfNotExist && create && !create.name) {
      throw new TypeError("With createIfNotExist, a new drive in mountDrives needs a name; otherwise every call would create another drive.");
    }
  }
}

/** Runs tasks with at most `limit` in flight; a freed slot goes straight to the next waiter. */
function limiter(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>(resolve => waiting.push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/** What this call did with one `mountDrives` entry. */
type Entry = {
  /** The drive's name, once known. */
  name?: string;
  /** Looked up or created, and not deleted since. */
  exists?: boolean;
  /** Created by this call (not an existing drive it reused). */
  created?: boolean;
  /** The create request's outcome is unknown: the drive may exist. */
  unconfirmed?: boolean;
  /** Mounted, or the mount's outcome is unknown. */
  mounted?: boolean;
};

/**
 * Drives for one `SandboxInstance.create` call. Looking up or creating drives
 * (`start`) runs alongside the sandbox creation, at most
 * `MOUNT_DRIVES_CONCURRENCY` at a time; only mounting waits for both the sandbox
 * and its drive (`mount`). On failure, drives this call created and did not
 * mount are deleted (`discard`, or `mount` when it fails).
 */
export class SandboxDriveSetup {
  private stopped = false;
  private prepared: Promise<DriveInstance | undefined>[] = [];
  private entries: Entry[];
  private region: Promise<string | undefined>;
  private setRegion!: (region: string | undefined) => void;

  /**
   * `region` is the region the sandbox creation request sends, if any. New
   * drives are created in it at once; without one they wait for the created
   * sandbox and use its region.
   */
  constructor(private mounts: SandboxDriveMountConfiguration[], region?: string) {
    this.entries = mounts.map(() => ({}));
    this.region = new Promise(resolve => { this.setRegion = resolve; });
    if (region) this.setRegion(region);
  }

  start() {
    const limit = limiter(MOUNT_DRIVES_CONCURRENCY);
    this.prepared = this.mounts.map((mount, index) => limit(async () => {
      if (this.stopped) return undefined;
      try {
        const drive = mount.create ? await this.createDrive(this.entries[index], mount.create) : await DriveInstance.get(mount.driveName);
        if (drive) Object.assign(this.entries[index], { name: drive.name, exists: true });
        return drive;
      } catch (e) {
        this.stopped = true;
        throw e;
      }
    }));
    // Failures surface in mount() or discard().
    for (const promise of this.prepared) promise.catch(() => { });
  }

  /** Create a drive in the sandbox's region; a named one that already exists is reused. */
  private async createDrive(entry: Entry, create: Omit<DriveCreateConfiguration, "region">) {
    const region = await this.region;
    if (this.stopped) return undefined;
    if (!region) throw new Error("The sandbox reports no region, so its drives were not created.");
    const requested = (create as DriveCreateConfiguration).region;
    if (requested && requested !== region) {
      throw new Error(`Drive region ${requested} does not match the sandbox region ${region}.`);
    }
    // Name unnamed drives here so that a create whose response is lost can still be looked up.
    const name = create.name || `drive-${uuidv4().replace(/-/g, "").slice(0, 16)}`;
    entry.name = name;
    try {
      const drive = await DriveInstance.create({ ...create, name, region });
      entry.created = true;
      return drive;
    } catch (e) {
      if (isConflict(e)) {
        // Only a name the caller chose can belong to an existing drive worth reusing.
        if (!create.name) throw e;
        return DriveInstance.get(name);
      }
      if (isRejected(e)) throw e;
      // The create may have succeeded server-side: look the drive up by its name.
      entry.unconfirmed = true;
      const drive = await DriveInstance.get(name).catch(() => { throw e; });
      entry.unconfirmed = false;
      // A generated name is this call's own; a chosen one may be an existing drive, which is never deleted.
      if (!create.name) entry.created = true;
      return drive;
    }
  }

  /**
   * The sandbox could not be created: stop, wait for drives in flight and delete
   * the ones this call created. Returns the error to throw: `cause` itself, or a
   * `SandboxDriveSetupError` naming drives that could not be deleted.
   */
  async discard(cause: unknown) {
    this.stopped = true;
    this.setRegion(undefined);
    await Promise.allSettled(this.prepared);
    await this.rollback();
    const left = this.leftCreated();
    return left.length ? new SandboxDriveSetupError(undefined, this.leftNames(), left, cause) : cause;
  }

  /** Mount each drive as soon as it is ready, then check the sandbox lists the mounts as requested. */
  async mount(sandbox: SandboxInstance) {
    const region = sandbox.spec?.region;
    this.setRegion(region);
    const limit = limiter(MOUNT_DRIVES_CONCURRENCY);
    const requests: DriveMountRequest[] = [];
    const results = await Promise.allSettled(this.prepared.map(async (prepared, index) => {
      try {
        const drive = await prepared;
        if (!drive) return;
        if (drive.region !== region) {
          throw new Error(`Drive ${drive.name} is in ${drive.region}, but the sandbox is in ${region}.`);
        }
        const { mountPath, drivePath = "/", readOnly = false } = this.mounts[index];
        const request = { driveName: drive.name, mountPath, drivePath, readOnly };
        await limit(async () => {
          if (this.stopped) return;
          requests.push(request);
          try {
            await sandbox.drives.mount(request);
            this.entries[index].mounted = true;
          } catch (e) {
            // A mount whose outcome is unknown may be in use: its drive is kept.
            if (!isRejected(e)) this.entries[index].mounted = true;
            throw e;
          }
        });
      } catch (e) {
        this.stopped = true;
        throw e;
      }
    }));
    try {
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) throw failed.reason;
      // Mounting reports success even if an existing mount at that path keeps a different readOnly, so check.
      const mounted = await sandbox.drives.list();
      for (const request of requests) {
        const actual = mounted.find(mount => cleanPath(mount.mountPath) === cleanPath(request.mountPath));
        if (actual?.driveName !== request.driveName || cleanPath(actual.drivePath) !== cleanPath(request.drivePath) || (actual.readOnly ?? false) !== request.readOnly) {
          throw new Error(`${request.mountPath} is not mounted as requested; see sandbox.drives.list().`);
        }
      }
    } catch (cause) {
      await this.rollback();
      throw new SandboxDriveSetupError(sandbox, this.leftNames(), this.leftCreated(), cause);
    }
  }

  /** Delete the drives this call created and did not mount. A failed deletion leaves the drive listed in `leftCreated`. */
  private async rollback() {
    const limit = limiter(MOUNT_DRIVES_CONCURRENCY);
    await Promise.all(this.entries.filter(entry => entry.created && entry.exists && !entry.mounted).map(entry => limit(async () => {
      try {
        await DriveInstance.delete(entry.name!);
        entry.exists = false;
      } catch {
        // Reported through SandboxDriveSetupError.createdDrives.
      }
    })));
  }

  private leftNames() {
    return this.entries.filter(entry => entry.exists).map(entry => entry.name!);
  }

  private leftCreated() {
    return this.entries.filter(entry => (entry.created && entry.exists) || entry.unconfirmed).map(entry => entry.name!);
  }
}
