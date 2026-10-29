import { deleteSecret, listSecrets, upsertSecret, type Secret } from "../client/index.js";

/**
 * Workspace secret, referenced from a sandbox's proxy routing as `{{SECRET:name}}`.
 *
 * Secrets are write-only: once set, only `name`, `destinations`, `createdAt` and
 * `updatedAt` can be read back. Every `set` stores a new immutable version and the
 * latest one is what the proxy resolves, only toward the secret's `destinations`
 * (a host, optionally followed by a path glob, e.g. `api.stripe.com` or
 * `api.example.com/v1/*`).
 */
export class SecretInstance {
  constructor(private secret: Secret) {}

  get name() {
    return this.secret.name;
  }

  get destinations() {
    return this.secret.destinations;
  }

  get createdAt() {
    return this.secret.createdAt;
  }

  get updatedAt() {
    return this.secret.updatedAt;
  }

  /** Create the secret, or store a new version (value and destinations) if it already exists. */
  static async set(name: string, value: string, destinations: string[]) {
    const { data } = await upsertSecret({
      body: { name, value, destinations },
      throwOnError: true,
    });
    return new SecretInstance(data);
  }

  static async list() {
    const { data } = await listSecrets({ throwOnError: true });
    return data.map((secret) => new SecretInstance(secret));
  }

  /** Delete the secret and all of its versions. Deleting an unknown secret is a no-op. */
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
