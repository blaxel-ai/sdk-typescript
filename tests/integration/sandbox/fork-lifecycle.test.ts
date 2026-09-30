import { SandboxInstance, SandboxLifecycle } from "@blaxel/core";
import { afterAll, describe, expect, it } from "vitest";
import { defaultImage, defaultLabels, defaultRegion, skipUnlessGenerationMk31, uniqueName } from "./helpers.js";

const policies = (lifecycle: SandboxLifecycle | undefined) =>
  (lifecycle?.expirationPolicies ?? []).map(({ type, value }) => ({ type, value }));

describe("Sandbox fork lifecycle", { timeout: 60000 }, () => {
  const sourceName = uniqueName("fork-lc-src");
  const inheritedName = uniqueName("fork-lc-inh");
  const requestedName = uniqueName("fork-lc-req");

  afterAll(async () => {
    await Promise.all(
      [requestedName, inheritedName, sourceName].map(async (name) => {
        try {
          await SandboxInstance.delete(name);
        } catch {
          // Ignore
        }
      })
    );
  });

  it("inherits the source's expiration unless the fork names its own", async (ctx) => {
    // Forks only exist on mk3.1 sandboxes.
    await skipUnlessGenerationMk31(ctx, "forks");

    const source = await SandboxInstance.create({
      name: sourceName,
      image: defaultImage,
      region: defaultRegion,
      labels: defaultLabels,
      ttl: "3h",
      lifecycle: {
        expirationPolicies: [
          { type: "ttl-max-age", value: "2h", action: "delete" },
          { type: "ttl-idle", value: "1h", action: "delete" },
        ],
      },
    });

    await source.fork(inheritedName);
    const inherited = await SandboxInstance.get(inheritedName);
    expect(policies(inherited.spec.lifecycle)).toEqual([
      { type: "ttl-max-age", value: "2h" },
      { type: "ttl-idle", value: "1h" },
    ]);
    expect(inherited.spec.runtime?.ttl).toBe("3h");

    await source.fork(requestedName, {
      lifecycle: { expirationPolicies: [{ type: "ttl-max-age", value: "45m", action: "delete" }] },
    });
    const requested = await SandboxInstance.get(requestedName);
    expect(policies(requested.spec.lifecycle)).toEqual([{ type: "ttl-max-age", value: "45m" }]);
  });
});
