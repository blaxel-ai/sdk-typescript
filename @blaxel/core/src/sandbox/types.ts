import { Port, Sandbox } from "../client/types.gen";

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