import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { h2TransportStats, SandboxInstance } from "@blaxel/core";
import {
  defaultImage,
  defaultLabels,
  defaultRegion,
  uniqueName,
} from "./helpers.js";

describe("H2 transport stats", () => {
  const sandboxName = uniqueName("h2-stats");
  let sandbox: SandboxInstance;

  beforeAll(async () => {
    sandbox = await SandboxInstance.create({
      name: sandboxName,
      image: defaultImage,
      region: defaultRegion,
      memory: 2048,
      labels: defaultLabels,
    });
  });

  afterAll(async () => {
    h2TransportStats.reset();
    await SandboxInstance.delete(sandboxName).catch(() => {});
  });

  it("counts a successful unsupported-body fallback through the sandbox API", async () => {
    h2TransportStats.reset();

    await sandbox.fs.writeBinary("/tmp/h2-stats.bin", new Uint8Array([1, 2, 3]));
    const content = new Uint8Array(await (await sandbox.fs.readBinary("/tmp/h2-stats.bin")).arrayBuffer());

    expect(content).toEqual(new Uint8Array([1, 2, 3]));
    const snapshot = h2TransportStats.snapshot();
    expect(snapshot).toMatchObject({
      establishFailures: 0,
      fetchFallbacks: 1,
      fallbacksByReason: {
        "no-session": 0,
        "request-rejected": 0,
        "session-unusable": 0,
        "unsupported-body": 1,
      },
    });
    expect(Object.values(snapshot.byDomain)).toHaveLength(1);
    expect(Object.values(snapshot.byDomain)[0]?.fallbacksByReason["unsupported-body"]).toBe(1);
  });
});
