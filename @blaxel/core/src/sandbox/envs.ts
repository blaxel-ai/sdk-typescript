import type { Env } from "../client/index.js";

/** What `SandboxInstance.updateEnvs` accepts: `{ NAME: "value" }` (`null` removes `NAME`) or a list of envs. */
export type SandboxEnvsUpdate = Record<string, string | null> | Env[];

/**
 * Merge `envs` into `current` by name. A record sets each name to its value
 * and removes the names set to `null`; a list sets each entry as given
 * (`secret` included). With `replace`, `current` is dropped first. Existing
 * variables keep their position, new ones are appended in the given order.
 */
export function updatedEnvs(current: Env[] | undefined, envs: SandboxEnvsUpdate, replace = false): Env[] {
  const changes = new Map<string, Env | null>();
  if (Array.isArray(envs)) {
    for (const env of envs) {
      if (!env.name) {
        // Name only the fields, never their values: an entry can hold a secret.
        throw new Error(`Environment variable without a name (fields: ${Object.keys(env).sort().join(", ")})`);
      }
      changes.set(env.name, env);
    }
  } else {
    for (const [name, value] of Object.entries(envs)) {
      changes.set(name, value === null ? null : { name, value });
    }
  }

  const result: Env[] = [];
  if (!replace) {
    for (const env of current ?? []) {
      if (env.name !== undefined && changes.has(env.name)) {
        const change = changes.get(env.name);
        changes.delete(env.name);
        if (change) result.push(change);
      } else {
        result.push(env);
      }
    }
  }
  for (const change of changes.values()) {
    if (change) result.push(change);
  }
  return result;
}
