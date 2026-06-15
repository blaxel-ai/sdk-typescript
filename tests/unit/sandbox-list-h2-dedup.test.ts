import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxInstance, settings } from "@blaxel/core";
import * as h2poolModule from "../../@blaxel/core/dist/esm/common/h2pool.js";

const makeSandbox = (name: string, region?: string) =>
  ({
    metadata: { name },
    spec: region ? { region } : {},
    status: "DEPLOYED",
  }) as any;

/**
 * Mock the control-plane client so `listSandboxes` never hits the network.
 * The compiled `sandbox.js` imports `listSandboxes` from `../client/index.js`
 * (relative to dist/esm/sandbox/), so we mock the dist-level client barrel.
 */
vi.mock("../../@blaxel/core/dist/esm/client/index.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    listSandboxes: vi.fn(),
  };
});

// Grab the mocked listSandboxes so we can configure per-test return values.
import { listSandboxes } from "../../@blaxel/core/dist/esm/client/index.js";
const listSandboxesMock = vi.mocked(listSandboxes);

describe("SandboxInstance.list() H2 session deduplication", () => {
  let h2GetSpy: ReturnType<typeof vi.spyOn>;
  const fakeSessionA = { __fake: "session-a" } as any;
  const fakeSessionB = { __fake: "session-b" } as any;

  beforeEach(() => {
    h2GetSpy = vi.spyOn(h2poolModule.h2Pool, "get");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls h2Pool.get() once for N sandboxes in the same region", async () => {
    const sandboxes = Array.from({ length: 10 }, (_, i) =>
      makeSandbox(`sb-${i}`, "us-east-1"),
    );
    listSandboxesMock.mockResolvedValue({
      response: new Response(),
      data: sandboxes,
    } as any);
    h2GetSpy.mockResolvedValue(fakeSessionA);

    const instances = await SandboxInstance.list();

    expect(h2GetSpy).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(10);
    for (const inst of instances) {
      expect(inst.h2Session).toBe(fakeSessionA);
    }
  });

  it("calls h2Pool.get() exactly twice for sandboxes across 2 regions", async () => {
    const sandboxes = [
      makeSandbox("sb-0", "us-east-1"),
      makeSandbox("sb-1", "us-east-1"),
      makeSandbox("sb-2", "eu-west-1"),
      makeSandbox("sb-3", "eu-west-1"),
      makeSandbox("sb-4", "us-east-1"),
    ];
    listSandboxesMock.mockResolvedValue({
      response: new Response(),
      data: sandboxes,
    } as any);
    h2GetSpy.mockImplementation(async (domain: string) => {
      if (domain.includes("us-east-1")) return fakeSessionA;
      if (domain.includes("eu-west-1")) return fakeSessionB;
      return {} as any;
    });

    const instances = await SandboxInstance.list();

    expect(h2GetSpy).toHaveBeenCalledTimes(2);
    expect(instances).toHaveLength(5);

    for (const inst of [instances[0], instances[1], instances[4]]) {
      expect(inst.h2Session).toBe(fakeSessionA);
    }
    for (const inst of [instances[2], instances[3]]) {
      expect(inst.h2Session).toBe(fakeSessionB);
    }
  });

  it("assigns the same session to both instance.h2Session and sandbox.h2Session", async () => {
    const sandboxes = [
      makeSandbox("sb-0", "us-east-1"),
      makeSandbox("sb-1", "us-east-1"),
    ];
    listSandboxesMock.mockResolvedValue({
      response: new Response(),
      data: sandboxes,
    } as any);
    h2GetSpy.mockResolvedValue(fakeSessionA);

    const instances = await SandboxInstance.list();

    for (const inst of instances) {
      expect(inst.h2Session).toBe(fakeSessionA);
      expect((inst as any).sandbox.h2Session).toBe(fakeSessionA);
      expect((inst as any).sandbox.h2Domain).toContain("us-east-1");
    }
  });

  it("skips sandboxes with no region gracefully", async () => {
    const sandboxes = [
      makeSandbox("sb-no-region"),
      makeSandbox("sb-with-region", "us-east-1"),
      makeSandbox("sb-no-region-2"),
    ];
    listSandboxesMock.mockResolvedValue({
      response: new Response(),
      data: sandboxes,
    } as any);
    h2GetSpy.mockResolvedValue(fakeSessionA);

    const instances = await SandboxInstance.list();

    expect(h2GetSpy).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(3);
    expect(instances[0].h2Session).toBeNull();
    expect(instances[2].h2Session).toBeNull();
    expect(instances[1].h2Session).toBe(fakeSessionA);
  });

  it("never calls h2Pool.get() when settings.disableH2 is true", async () => {
    const sandboxes = [
      makeSandbox("sb-0", "us-east-1"),
      makeSandbox("sb-1", "eu-west-1"),
    ];
    listSandboxesMock.mockResolvedValue({
      response: new Response(),
      data: sandboxes,
    } as any);
    h2GetSpy.mockResolvedValue(fakeSessionA);

    const original = settings.config.disableH2;
    settings.config.disableH2 = true;

    try {
      const instances = await SandboxInstance.list();

      expect(h2GetSpy).not.toHaveBeenCalled();
      expect(instances).toHaveLength(2);
      expect(instances[0].h2Session).toBeNull();
      expect(instances[1].h2Session).toBeNull();
    } finally {
      settings.config.disableH2 = original;
    }
  });
});
