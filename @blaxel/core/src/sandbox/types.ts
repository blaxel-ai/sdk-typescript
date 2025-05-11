import { Sandbox } from "../client/types.gen";

export interface SessionCreateOptions {
  expiresAt?: Date;
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