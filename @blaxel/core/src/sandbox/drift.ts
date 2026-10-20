import type { Env } from "../client/index.js";

/** The fields of a create request that are compared with an existing sandbox. A field the caller did not set is not compared. */
export type RequestedSandbox = {
  image?: string;
  memory?: number;
  region?: string;
  envs?: Env[];
};

type ExistingSandbox = {
  metadata?: { name?: string };
  spec?: { region?: string; runtime?: { image?: string; memory?: number; envs?: Env[] } };
};

// The control plane masks every env value it reads back, so values can only be compared when it did not.
const MASKED_ENV_VALUE = "****";

// The control plane keeps the image reference as submitted: "app" and "app:latest" are the same image.
function withTag(image: string): string {
  if (image.includes("@")) return image;
  return image.indexOf(":", image.lastIndexOf("/") + 1) === -1 ? `${image}:latest` : image;
}

function envDrift(requested: Env[], existing: Env[]): string | undefined {
  const byName = new Map(existing.map((env) => [env.name, env]));
  const missing: string[] = [];
  const changed: string[] = [];
  for (const env of requested) {
    const current = byName.get(env.name);
    if (!current) missing.push(env.name ?? "");
    else if (current.value !== undefined && current.value !== MASKED_ENV_VALUE && current.value !== env.value) changed.push(env.name ?? "");
  }
  // Names only: env values are often secrets and never go into a log line.
  const parts = [
    missing.length ? `not set on the existing sandbox: ${missing.join(", ")}` : "",
    changed.length ? `different value: ${changed.join(", ")}` : "",
  ].filter(Boolean);
  return parts.length ? `envs (${parts.join("; ")})` : undefined;
}

/**
 * Describes how an existing sandbox differs from the configuration that was
 * asked for, one entry per field (image, memory, region, envs). Empty when
 * nothing differs. A field the existing sandbox does not report is not drift.
 */
export function describeDrift(requested: RequestedSandbox, existing: ExistingSandbox): string[] {
  const drift: string[] = [];
  const runtime = existing.spec?.runtime;
  if (requested.image && runtime?.image && withTag(requested.image) !== withTag(runtime.image)) {
    drift.push(`image (requested ${requested.image}, existing ${runtime.image})`);
  }
  if (requested.memory !== undefined && runtime?.memory !== undefined && requested.memory !== runtime.memory) {
    drift.push(`memory (requested ${requested.memory} MB, existing ${runtime.memory} MB)`);
  }
  if (requested.region && existing.spec?.region && requested.region !== existing.spec.region) {
    drift.push(`region (requested ${requested.region}, existing ${existing.spec.region})`);
  }
  if (requested.envs?.length && runtime?.envs) {
    const envs = envDrift(requested.envs, runtime.envs);
    if (envs) drift.push(envs);
  }
  return drift;
}

/** The single warning createIfNotExists logs when the sandbox it returned is not the one that was asked for. */
export function driftWarning(name: string | undefined, drift: string[]): string {
  return (
    `SandboxInstance.createIfNotExists: sandbox ${name ? `"${name}" ` : ""}already exists, so it was returned as is and the requested configuration was not applied. ` +
    `It differs on: ${drift.join("; ")}. ` +
    "Delete the sandbox and create it again to apply the new configuration."
  );
}
