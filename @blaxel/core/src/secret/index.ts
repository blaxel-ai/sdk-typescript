import { deleteSecret, listSecrets, upsertSecret, type Secret } from "../client/index.js";

/**
 * Delivery of a secret's latest change to every region's proxy: `PENDING`
 * while a region has not applied it yet, `DEGRADED` when one has been behind
 * for more than 15 minutes, `DELETING` for a deleted secret not yet removed
 * everywhere. Absent once every region applied it.
 */
export type SecretStatus = NonNullable<Secret["status"]>;

/**
 * Workspace secret, referenced from a sandbox's proxy routing as
 * `{{SECRET:name}}`.
 *
 * Secrets are write-only: once set, only `name`, `destinations`, `status`,
 * `createdAt` and `updatedAt` can be read back. Every `set` stores a new
 * immutable version and the latest one is what the proxy resolves, only
 * toward the secret's `destinations` (a host, optionally followed by a path
 * glob, e.g. `api.stripe.com` or `api.example.com/v1/*`).
 *
 * @example
 * ```typescript
 * const secret = await SecretInstance.set("stripe-key", "sk_live_...", ["api.stripe.com"]);
 * console.log(secret.name, secret.destinations, secret.status);
 * await SecretInstance.delete("stripe-key");
 * ```
 */
export class SecretInstance {
  constructor(private secret: Secret) {}

  /** Case-sensitive secret name. */
  get name() {
    return this.secret.name;
  }

  /** Hosts (optionally with a path glob) the secret is substituted toward. Empty for a deleted secret. */
  get destinations(): string[] {
    return this.secret.destinations ?? [];
  }

  /** Delivery of the latest change to every region, `undefined` once all applied it. */
  get status(): SecretStatus | undefined {
    return this.secret.status;
  }

  get createdAt() {
    return this.secret.createdAt;
  }

  get updatedAt() {
    return this.secret.updatedAt;
  }

  /**
   * Create the secret, or store a new version (value and destinations) if it
   * already exists.
   *
   * @param destinations - At least one host the secret may be sent to,
   *   optionally followed by a path glob. A bare `*` is rejected.
   * @throws When the name, value or destinations are invalid (HTTP 400).
   */
  static async set(name: string, value: string, destinations: string[]) {
    const { data } = await upsertSecret({
      body: { name, value, destinations },
      throwOnError: true,
    });
    return new SecretInstance(data);
  }

  /** List the workspace's secrets, including deleted ones still being removed (`status` `DELETING`). */
  static async list() {
    const { data } = await listSecrets({ throwOnError: true });
    return data.map((secret) => new SecretInstance(secret));
  }

  /**
   * Delete the secret and all of its versions. Deleting an already deleted
   * secret returns it again.
   *
   * @throws When no secret ever had this name (HTTP 404).
   */
  static async delete(secretName: string) {
    const { data } = await deleteSecret({
      path: { secretName },
      throwOnError: true,
    });
    return data;
  }

  async delete() {
    return await SecretInstance.delete(this.secret.name);
  }
}
