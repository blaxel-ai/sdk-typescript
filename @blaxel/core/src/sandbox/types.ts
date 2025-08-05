import { Port, Sandbox } from "../client/types.gen";
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

export type SandboxConfiguration = {
  forceUrl?: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
} & Sandbox;

export type SandboxCreateConfiguration = {
  name?: string;
  image?: string;
  memory?: number;
  ports?: (Port | Record<string, any>)[];
  envs?: EnvVar[];
  ttl?: string;
  expiresAt?: Date;
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

export type ProcessRequestWithLog = ProcessRequest & {
  onLog?: (log: string) => void;
}

export type ProcessResponseWithLog = PostProcessResponse & {
  close: () => void;
}
