import { DriveInstance } from "../drive/index.js";
import type { DriveMountRequest } from "./drive/index.js";
import type { SandboxInstance } from "./sandbox.js";
import type { SandboxDriveMountConfiguration } from "./types.js";

/** Most drive lookups/creations, and most mounts, in flight at once. */
export const MOUNT_DRIVES_CONCURRENCY = 5;

/**
 * Thrown when a sandbox is ready but one of its `mountDrives` could not be
 * set up. The sandbox, drives and mounts made so far remain. `driveNames` lists
 * the drives this call looked up or created; delete only the ones you created.
 * (If the sandbox itself cannot be created, its error is thrown instead and the
 * drives this call created are deleted.)
 */
export class SandboxDriveSetupError extends Error {
  constructor(readonly sandbox: SandboxInstance, readonly driveNames: string[], cause: unknown) {
    const detail = cause instanceof Error ? cause.message : JSON.stringify(cause);
    super(`Sandbox ${sandbox.metadata.name} is ready, but mounting its drives failed: ${detail}`, { cause });
    this.name = "SandboxDriveSetupError";
  }
}

const cleanPath = (path = "/") => `/${path.split("/").filter(Boolean).join("/")}`;

const isConflict = (e: unknown) =>
  typeof e === "object" && e !== null && "code" in e && (e.code === 409 || e.code === "DRIVE_ALREADY_EXISTS");

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

/**
 * Drives for one `SandboxInstance.create` call. Looking up or creating drives
 * (`start`) runs alongside the sandbox creation, at most
 * `MOUNT_DRIVES_CONCURRENCY` at a time; only mounting waits for both the sandbox
 * and its drive (`mount`). A drive created for a sandbox that could not be
 * created is deleted again (`discard`).
 */
export class SandboxDriveSetup {
  private stopped = false;
  private prepared: Promise<DriveInstance | undefined>[] = [];
  private looked: (string | undefined)[] = [];
  private created: string[] = [];
  private region: Promise<string | undefined>;
  private setRegion!: (region: string | undefined) => void;

  /** `region` is the sandbox's region if known before it is created; otherwise new drives wait for the created sandbox. */
  constructor(private mounts: SandboxDriveMountConfiguration[], region?: string) {
    this.region = new Promise(resolve => { this.setRegion = resolve; });
    if (region) this.setRegion(region);
  }

  start() {
    const limit = limiter(MOUNT_DRIVES_CONCURRENCY);
    this.prepared = this.mounts.map((mount, index) => limit(async () => {
      if (this.stopped) return undefined;
      let drive: DriveInstance;
      try {
        if (!mount.create) {
          drive = await DriveInstance.get(mount.driveName);
        } else {
          const region = await this.region;
          if (this.stopped) return undefined;
          const config = { ...mount.create, region };
          try {
            drive = await DriveInstance.create(config);
            this.created.push(drive.name);
          } catch (e) {
            // A named drive is reused if it exists; an unnamed one cannot conflict.
            if (!config.name || !isConflict(e)) throw e;
            drive = await DriveInstance.get(config.name);
          }
        }
      } catch (e) {
        this.stopped = true;
        throw e;
      }
      this.looked[index] = drive.name;
      return drive;
    }));
    // Failures surface in mount() or discard().
    for (const promise of this.prepared) promise.catch(() => { });
  }

  /** The sandbox could not be created: stop, wait for drives in flight, delete the ones this call created. */
  async discard() {
    this.stopped = true;
    this.setRegion(undefined);
    await Promise.allSettled(this.prepared);
    await Promise.all(this.created.map(name => DriveInstance.delete(name).catch(() => { })));
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
        requests.push(request);
        await limit(async () => {
          if (!this.stopped) await sandbox.drives.mount(request);
        });
      } catch (e) {
        this.stopped = true;
        throw e;
      }
    }));
    const driveNames = this.looked.filter((name): name is string => name !== undefined);
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
      throw new SandboxDriveSetupError(sandbox, driveNames, cause);
    }
  }
}
