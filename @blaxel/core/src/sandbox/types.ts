import { Sandbox } from "../client/types.gen";

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
}