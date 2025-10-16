import { Port, Sandbox, SandboxLifecycle, VolumeAttachment } from "../client/types.gen";
import { PostProcessResponse, ProcessRequest } from "./client";

export interface SessionCreateOptions {
  expiresAt?: Date;
  responseHeaders?: Record<string, string>;
  requestHeaders?: Record<string, string>;
}

export interface SessionWithToken {
  name: string;
  url: string;
  token: string;
  expiresAt: Date;
}

export interface EnvVar {
  name: string;
  value: string;
}

export interface VolumeBinding {
  name: string; // Name of the volume to attach
  mountPath: string; // Path where the volume should be mounted
  readOnly?: boolean; // Whether the volume is mounted as read-only
}

export type SandboxConfiguration = {
  forceUrl?: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
} & Sandbox;

export type SandboxUpdateMetadata = {
  labels?: Record<string, string>;
  displayName?: string;
}

export type SandboxCreateConfiguration = {
  name?: string;
  image?: string;
  memory?: number;
  ports?: (Port | Record<string, any>)[];
  envs?: EnvVar[];
  volumes?: (VolumeBinding | VolumeAttachment)[];
  ttl?: string;
  expires?: Date;
  region?: string;
  lifecycle?: SandboxLifecycle;
  snapshotEnabled?: boolean;
}

export function normalizePorts(ports?: (Port | Record<string, any>)[]): Port[] | undefined {
  if (!ports || ports.length === 0) {
    return undefined;
  }

  const portObjects: Port[] = [];
  for (const port of ports) {
    if (typeof port === 'object' && port !== null) {
      if ('name' in port || 'target' in port || 'protocol' in port) {
        // It's a Port-like object, ensure protocol defaults to HTTP
        const normalizedPort: Port = {
          name: typeof port.name === 'string' ? port.name : undefined,
          target: typeof port.target === 'number' ? port.target : undefined,
          protocol: typeof port.protocol === 'string' ? port.protocol : "HTTP"
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

      volumeObjects.push(volumeAttachment);
    } else {
      throw new Error(`Invalid volume type: ${typeof volume}. Expected object with 'name' and 'mountPath' keys.`);
    }
  }

  return volumeObjects;
}

export type ProcessRequestWithLog = ProcessRequest & {
  onLog?: (log: string) => void;
}

export type ProcessResponseWithLog = PostProcessResponse & {
  close: () => void;
}
