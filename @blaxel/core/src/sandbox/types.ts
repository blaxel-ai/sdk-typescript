import type http2 from "http2";
import type { DriveCreateConfiguration } from "../drive/index.js";
import { Port, Sandbox, SandboxLifecycle, VolumeAttachment, SandboxNetwork } from "../client/types.gen";
import { PostProcessResponse, ProcessRequest } from "./client";

/** Options of `sandbox.sessions.create()`. */
export interface SessionCreateOptions {
  /** When the session and its token expire. Defaults to 24 hours from now. */
  expiresAt?: Date;
  /** Headers added to every response served through the session URL (for example CORS headers). */
  responseHeaders?: Record<string, string>;
  /** Headers added to every request forwarded to the sandbox through the session URL. */
  requestHeaders?: Record<string, string>;
}

/**
 * A session: a private preview URL of the sandbox API plus the token that
 * opens it. Pass it to `SandboxInstance.fromSession()` to reach the sandbox
 * without a Blaxel API key, for example from a browser.
 */
export interface SessionWithToken {
  /** Name of the preview backing the session (`session-<timestamp>`). */
  name: string;
  /** URL of the sandbox API reached through the session. */
  url: string;
  /** Preview token, sent as the `X-Blaxel-Preview-Token` header. */
  token: string;
  /** When the token expires. */
  expiresAt: Date;
}

/** An environment variable set in the sandbox. */
export interface EnvVar {
  name: string;
  value: string;
}

export interface VolumeBinding {
  name: string; // Name of the volume to attach
  mountPath: string; // Path where the volume should be mounted
  readOnly?: boolean; // Whether the volume is mounted as read-only
  type?: "persistent" | "ephemeral"; // Volume type, defaults to "persistent"
  sizeMb?: number; // Storage capacity in MB, required for ephemeral volumes
}

export type SandboxConfiguration = {
  forceUrl?: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  h2Session?: http2.ClientHttp2Session | null;
  h2Domain?: string | null;
} & Sandbox;

/** Metadata fields `SandboxInstance.updateMetadata()` can change. Fields left out keep their value. */
export type SandboxUpdateMetadata = {
  /** Replaces the whole label map: include the labels to keep. */
  labels?: Record<string, string>;
  /** Human-readable name, at most 63 characters. */
  displayName?: string;
  /** Caller-owned identifier for `SandboxInstance.getByExternalId()`: letters, digits and hyphens, at most 64 characters. */
  externalId?: string;
}

/** Argument of `SandboxInstance.updateNetwork()`. */
export type SandboxUpdateNetwork = {
  /** The network configuration to apply; it replaces the sandbox's current one. */
  network?: SandboxNetwork;
}

/**
 * A drive to mount on the sandbox: `driveName` for a drive that already
 * exists, `create` for a new one. New drives are created in the sandbox's region.
 */
export type SandboxDriveMountConfiguration = {
  mountPath: string;
  drivePath?: string;
  readOnly?: boolean;
} & (
  | { driveName: string; create?: never }
  | { create: Omit<DriveCreateConfiguration, "region">; driveName?: never }
);

export type SandboxPreviewCreateConfiguration = {
  port: number;
  /** Defaults to preview-<port> within this sandbox. */
  name?: string;
  /** Defaults to false on creation; existing previews are not changed. */
  public?: boolean;
};

/**
 * Shorthand configuration of `SandboxInstance.create()` and
 * `SandboxInstance.createIfNotExists()`. Every field is optional.
 */
export type SandboxCreateConfiguration = {
  /**
   * Sandbox name, unique in the workspace: lowercase letters, digits and
   * hyphens, at most 49 characters; any other name is rejected with HTTP 400.
   * Immutable. Omit it to let the platform assign one.
   */
  name?: string;
  /** Image to run. Defaults to `blaxel/base-image:latest`. */
  image?: string;
  /** Memory in MB. Defaults to 4096. CPU scales with it (memory / 2048 cores, so 4096 MB is 2 CPUs). */
  memory?: number;
  /** Ports to expose, as `{ name?, target, protocol? }`; `protocol` (`HTTP`, `TCP` or `UDP`) defaults to `HTTP`. */
  ports?: (Port | Record<string, any>)[];
  /** Environment variables of the sandbox. */
  envs?: EnvVar[];
  /** Volumes to attach: an existing volume by name, or an ephemeral one with `type: "ephemeral"` and `sizeMb`. */
  volumes?: (VolumeBinding | VolumeAttachment)[];
  /**
   * Maximum age: the sandbox is deleted this long after creation, active or
   * not (not an idle timeout). Units s, m, h, d, w, for example `"30m"` or
   * `"24h"`. Minimum `"5m"`; a shorter value is rejected with HTTP 400. For
   * idle-based deletion use `lifecycle` with a `ttl-idle` policy.
   * See https://docs.blaxel.ai/Sandboxes/Lifecycle-recipe.
   */
  ttl?: string;
  /** Absolute time at which the sandbox is deleted. */
  expires?: Date;
  /**
   * Region to deploy in, such as `"us-pdx-1"`, `"us-was-1"` or `"eu-lon-1"`.
   * Defaults to the `BL_REGION` environment variable; a warning is logged
   * when neither is set. Volumes and drives must be in the same region.
   */
  region?: string;
  /**
   * Automatic deletion rules. Each policy needs `action: "delete"` and a
   * `type`: `ttl-idle` (after that long without activity, minimum `"60s"`),
   * `ttl-max-age` (after that long since creation, minimum `"5m"`) or `date`
   * (ISO 8601 time). Shorter durations are rejected with HTTP 400. Each type
   * may appear once; the first condition met triggers deletion.
   * See https://docs.blaxel.ai/Sandboxes/Lifecycle-recipe.
   */
  lifecycle?: SandboxLifecycle;
  /** Network configuration: egress gateway, firewall rulesets, proxy and allowed or forbidden domains. */
  network?: SandboxNetwork;
  snapshotEnabled?: boolean;
  /** Labels to organize and filter sandboxes. */
  labels?: Record<string, string>;
  /** Kernel selection arguments (such as `tun` or `iptables`). Immutable after creation. */
  extraArgs?: Record<string, string>;
  /** Caller-owned identifier to find the sandbox again with `SandboxInstance.getByExternalId()`: letters, digits and hyphens, at most 64 characters. */
  externalId?: string;
  /** Seconds the sandbox gets after SIGTERM to exit before it is deleted. Defaults to 0. */
  terminationGracePeriodSeconds?: number;
  /** Seconds the sandbox gets after SIGUSR2 to prepare before standby. Defaults to 0. */
  standbyGracePeriodSeconds?: number;
  /**
   * Registry credentials to pull a private registry image (e.g. ghcr.io/org/image:tag),
   * in Docker config.json format: { auths: { "ghcr.io": { auth: base64("user:token") } } }.
   * Only used when image is a registry reference.
   */
  dockerConfig?: string | Record<string, unknown>;
}

export function normalizePorts(ports?: (Port | Record<string, any>)[]): Port[] | undefined {
  if (!ports || ports.length === 0) {
    return undefined;
  }

  const portObjects: Port[] = [];
  for (const port of ports) {
    if (typeof port === 'object' && port !== null) {
      if ('name' in port || 'target' in port || 'protocol' in port) {
        if (typeof port.target !== 'number') {
          throw new Error(`Port target must be a number: ${JSON.stringify(port)}`);
        }
        // It's a Port-like object, ensure protocol defaults to HTTP
        const normalizedPort: Port = {
          name: typeof port.name === 'string' ? port.name : undefined,
          target: port.target,
          protocol: typeof port.protocol === 'string' ? port.protocol as "HTTP" | "TCP" | "UDP" : "HTTP"
        };
        portObjects.push(normalizedPort);
      } else {
        throw new Error(`Invalid port type: ${typeof port}. Expected Port object or object with port properties.`);
      }
    } else {
      throw new Error(`Invalid port type: ${typeof port}. Expected Port object or object with port properties.`);
    }
  }

  return portObjects;
}

export function normalizeEnvs(envs?: EnvVar[]): EnvVar[] | undefined {
  if (!envs || envs.length === 0) {
    return undefined;
  }

  const envObjects: EnvVar[] = [];
  for (const env of envs) {
    if (typeof env === 'object' && env !== null) {
      // Validate that the object has the required keys
      if (!('name' in env) || !('value' in env)) {
        throw new Error(`Environment variable object must have 'name' and 'value' keys: ${JSON.stringify(env)}`);
      }
      if (typeof env.name !== 'string' || typeof env.value !== 'string') {
        throw new Error(`Environment variable 'name' and 'value' must be strings: ${JSON.stringify(env)}`);
      }
      envObjects.push({ name: env.name, value: env.value });
    } else {
      throw new Error(`Invalid env type: ${typeof env}. Expected object with 'name' and 'value' keys.`);
    }
  }

  return envObjects;
}

export function normalizeVolumes(volumes?: (VolumeBinding | VolumeAttachment)[]): VolumeAttachment[] | undefined {
  if (!volumes || volumes.length === 0) {
    return undefined;
  }

  const volumeObjects: VolumeAttachment[] = [];
  for (const volume of volumes) {
    if (typeof volume === 'object' && volume !== null) {
      // Validate that the object has the required keys
      if (!('name' in volume) || !('mountPath' in volume)) {
        throw new Error(`Volume binding object must have 'name' and 'mountPath' keys: ${JSON.stringify(volume)}`);
      }
      if (typeof volume.name !== 'string' || typeof volume.mountPath !== 'string') {
        throw new Error(`Volume binding 'name' and 'mountPath' must be strings: ${JSON.stringify(volume)}`);
      }

      // Convert VolumeBinding to VolumeAttachment format
      const volumeAttachment: VolumeAttachment = {
        name: volume.name,
        mountPath: volume.mountPath,
        readOnly: 'readOnly' in volume ? volume.readOnly : false
      };

      // Ephemeral volumes carry a type and a required size (in MB)
      if ('type' in volume && volume.type) {
        volumeAttachment.type = volume.type;
      }
      if (volumeAttachment.type === 'ephemeral') {
        if (typeof volume.sizeMb !== 'number' || !(volume.sizeMb > 0)) {
          throw new Error(`Ephemeral volume '${volume.name}' must have a positive 'sizeMb': ${JSON.stringify(volume)}`);
        }
        volumeAttachment.sizeMb = volume.sizeMb;
      } else if ('sizeMb' in volume && typeof volume.sizeMb === 'number') {
        volumeAttachment.sizeMb = volume.sizeMb;
      }

      volumeObjects.push(volumeAttachment);
    } else {
      throw new Error(`Invalid volume type: ${typeof volume}. Expected object with 'name' and 'mountPath' keys.`);
    }
  }

  return volumeObjects;
}

/** A process request with optional log callbacks; see `SandboxProcess.exec()`. */
export type ProcessRequestWithLog = ProcessRequest & {
  /** Called with each chunk of output, stdout and stderr alike. */
  onLog?: (log: string) => void;
  /** Called with each chunk of stdout. */
  onStdout?: (stdout: string) => void;
  /** Called with each chunk of stderr. */
  onStderr?: (stderr: string) => void;
}

/** The process returned by `exec()` when log callbacks were passed. */
export type ProcessResponseWithLog = PostProcessResponse & {
  /** Stop streaming logs to the callbacks. The process keeps running. */
  close: () => void;
}
