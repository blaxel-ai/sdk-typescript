import { deleteSecret, listSecrets, upsertSecret, type Secret } from "../client/index.js";

/**
 * A workspace secret. Values are write-only: once set, only `name`, `createdAt`
 * and `updatedAt` can be read back. Every `set` stores a new immutable version
 * and the latest one is what the proxy resolves for `{{SECRET:name}}` references
 * in a sandbox's routing configuration.
 */
export class SecretInstance {
  constructor(private secret: Secret) {}

  get name() {
    return this.secret.name;
  }

  get createdAt() {
    return this.secret.createdAt;
  }

  get updatedAt() {
    return this.secret.updatedAt;
  }

  /** Create the secret, or store a new version if it already exists. */
  static async set(name: string, value: string): Promise<SecretInstance> {
    const { data } = await upsertSecret({
      body: { name, value },
      throwOnError: true,
    });
    return new SecretInstance(data);
  }

  static async list(): Promise<SecretInstance[]> {
    const { data } = await listSecrets({ throwOnError: true });
    return data.map((secret) => new SecretInstance(secret));
  }

  /** Delete the secret and all of its versions. */
  static async delete(name: string): Promise<Secret> {
    const { data } = await deleteSecret({
      path: { secretName: name },
      throwOnError: true,
    });
    return data;
  }

  async delete() {
    return await SecretInstance.delete(this.name);
  }
}
