import { SecretInstance, listSecrets } from "@blaxel/core";
import { afterAll, describe, expect, it } from "vitest";
import { uniqueName } from "./helpers.js";

const secretName = (prefix: string) => uniqueName(prefix).replace(/[^A-Za-z0-9_-]/g, "-");

// /secrets ships with controlplane#5736; skip until the target environment serves it.
const secretsApiDeployed = (await listSecrets()).response.status !== 404;

describe.skipIf(!secretsApiDeployed)("Workspace secrets", () => {
  const created: string[] = [];

  afterAll(async () => {
    await Promise.all(
      created.map(async (name) => {
        try {
          await SecretInstance.delete(name);
        } catch {
          // already deleted by the test
        }
      })
    );
  });

  it("set, list (metadata only), rotate and delete", async () => {
    const name = secretName("sdk-secret");
    created.push(name);

    const set = await SecretInstance.set(name, "first-value");
    expect(set.name).toBe(name);

    const listed = (await SecretInstance.list()).filter((s) => s.name === name);
    expect(listed).toHaveLength(1);
    expect(listed[0].createdAt).toBeTruthy();
    expect(listed[0].updatedAt).toBeTruthy();
    // the value must never come back from the API
    expect(JSON.stringify(listed[0])).not.toContain("first-value");

    await SecretInstance.set(name, "second-value");
    const rotated = (await SecretInstance.list()).filter((s) => s.name === name);
    expect(rotated).toHaveLength(1);
    expect(rotated[0].createdAt).toBe(listed[0].createdAt);
    expect(new Date(rotated[0].updatedAt!).getTime()).toBeGreaterThanOrEqual(new Date(listed[0].updatedAt!).getTime());
    expect(JSON.stringify(rotated[0])).not.toContain("second-value");

    const deleted = await SecretInstance.delete(name);
    expect(deleted.name).toBe(name);
    expect((await SecretInstance.list()).some((s) => s.name === name)).toBe(false);
  });

  it("rejects deleting an unknown secret", async () => {
    await expect(SecretInstance.delete(secretName("sdk-secret-missing"))).rejects.toThrow();
  });

  it("rejects an invalid name", async () => {
    await expect(SecretInstance.set("not a valid name!", "value")).rejects.toThrow();
  });
});
