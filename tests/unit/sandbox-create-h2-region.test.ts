import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

// Mock the generated client so create() never hits the control plane.
// sandbox.ts imports the same module, so vitest rewires both.
vi.mock("../../@blaxel/core/src/client/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../@blaxel/core/src/client/index.js")>();
  return { ...actual, createSandbox: vi.fn() };
});

import { createSandbox } from "../../@blaxel/core/src/client/index.js";
import { h2Pool } from "../../@blaxel/core/src/common/h2pool.js";
import { SandboxInstance } from "../../@blaxel/core/src/sandbox/sandbox.js";

const mockedCreate = vi.mocked(createSandbox);

const created = (region?: string) =>
  ({
    data: { metadata: { name: "sbx" }, spec: { region, runtime: {} }, status: "DEPLOYED" },
    response: { status: 200 },
  }) as never;

const fakeSession = { __fake: "session" } as never;

// The edge the sandbox talks to over HTTP/2 follows the region the sandbox
// landed in, which is only known from the create response when the request
// carried no region.
describe("SandboxInstance.create HTTP/2 edge selection", () => {
  let getSpy: MockInstance<typeof h2Pool.get>;
  let warmSpy: MockInstance<typeof h2Pool.warm>;

  beforeEach(() => {
    vi.stubEnv("BL_REGION", "");
    getSpy = vi.spyOn(h2Pool, "get").mockResolvedValue(fakeSession);
    warmSpy = vi.spyOn(h2Pool, "warm").mockResolvedValue(fakeSession);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    mockedCreate.mockReset();
  });

  it("attaches an HTTP/2 session for the region the platform picked when none was requested", async () => {
    mockedCreate.mockResolvedValueOnce(created("us-pdx-1"));

    const instance = await SandboxInstance.create({ image: "custom:latest" });

    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getSpy.mock.calls[0][0]).toContain("us-pdx-1");
    expect(instance.h2Domain).toContain("us-pdx-1");
    expect(instance.h2Session).toBe(fakeSession);
  });

  it("reuses the session warmed for the requested region when the sandbox lands there", async () => {
    mockedCreate.mockResolvedValueOnce(created("eu-lon-1"));

    const instance = await SandboxInstance.create({ image: "custom:latest", region: "eu-lon-1" });

    expect(warmSpy.mock.calls[0][0]).toContain("eu-lon-1");
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getSpy.mock.calls[0][0]).toContain("eu-lon-1");
    expect(instance.h2Domain).toContain("eu-lon-1");
    expect(instance.h2Session).toBe(fakeSession);
  });

  it("follows the sandbox's own region when it differs from the requested one", async () => {
    // createIfNotExist can hand back an existing sandbox living in another region.
    mockedCreate.mockResolvedValueOnce(created("us-was-1"));

    const instance = await SandboxInstance.create({ image: "custom:latest", region: "eu-lon-1" });

    const domains = getSpy.mock.calls.map(([domain]) => domain);
    expect(domains.at(-1)).toContain("us-was-1");
    expect(instance.h2Domain).toContain("us-was-1");
    expect(instance.h2Session).toBe(fakeSession);
  });

  it("stays on plain fetch when the response carries no region either", async () => {
    mockedCreate.mockResolvedValueOnce(created());

    const instance = await SandboxInstance.create({ image: "custom:latest" });

    expect(getSpy).not.toHaveBeenCalled();
    expect(instance.h2Domain).toBeNull();
    expect(instance.h2Session).toBeNull();
  });

  it("keeps the edge recorded when the session cannot be opened", async () => {
    getSpy.mockRejectedValue(new Error("edge unreachable"));
    mockedCreate.mockResolvedValueOnce(created("us-pdx-1"));

    const instance = await SandboxInstance.create({ image: "custom:latest" });

    expect(instance.h2Domain).toContain("us-pdx-1");
    expect(instance.h2Session).toBeNull();
  });
});
