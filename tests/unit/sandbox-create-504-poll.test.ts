import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the generated client so create/get can be scripted per test. sandbox.ts
// imports the same module ("../client/index.js"), so vitest rewires both.
vi.mock("../../@blaxel/core/src/client/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../@blaxel/core/src/client/index.js")>();
  return { ...actual, createSandbox: vi.fn(), getSandbox: vi.fn() };
});

import { createSandbox, getSandbox } from "../../@blaxel/core/src/client/index.js";
import { SandboxInstance } from "../../@blaxel/core/src/sandbox/sandbox.js";

const mockedCreate = vi.mocked(createSandbox);
const mockedGet = vi.mocked(getSandbox);

// What hey-api returns (without throwOnError) when CloudFront cuts the origin
// connection at 60s: an HTML body, no parsable JSON error payload.
const EDGE_504_BODY = "<html><body>504 Gateway Time-out</body></html>";
const edge504 = () =>
  ({ error: EDGE_504_BODY, response: { status: 504 }, request: {} }) as never;

const record = (status: string) =>
  ({ data: { metadata: { name: "slow" }, spec: { runtime: {} }, status } }) as never;

describe("SandboxInstance.create 504 gateway-timeout handling (ENG-3662)", () => {
  beforeEach(() => {
    // Keep edgeDomain null so create() skips the real H2 warm-up path.
    vi.stubEnv("BL_REGION", "");
    vi.useFakeTimers();
    // Zero the backoff jitter so poll delays are exactly 1s, 2s, 4s, 5s, ...
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    mockedCreate.mockReset();
    mockedGet.mockReset();
  });

  it("polls the record after a create 504 and resolves once the sandbox is DEPLOYED", async () => {
    mockedCreate.mockResolvedValueOnce(edge504());
    mockedGet
      .mockResolvedValueOnce(record("DEPLOYING"))
      .mockResolvedValueOnce(record("DEPLOYED"));

    const pending = SandboxInstance.create({ name: "slow" });
    // Backoff polls at +1s then +2s.
    await vi.advanceTimersByTimeAsync(3_000);

    const instance = await pending;
    expect(instance.status).toBe("DEPLOYED");
    expect(instance.metadata.name).toBe("slow");
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it("keeps polling through transient 404s on the record", async () => {
    mockedCreate.mockResolvedValueOnce(edge504());
    mockedGet
      .mockRejectedValueOnce({ code: 404 })
      .mockResolvedValueOnce(record("DEPLOYED"));

    const pending = SandboxInstance.create({ name: "slow" });
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(pending).resolves.toBeInstanceOf(SandboxInstance);
  });

  it("throws the original edge error when the sandbox never lands within the wait budget", async () => {
    mockedCreate.mockResolvedValueOnce(edge504());
    mockedGet.mockResolvedValue(record("DEPLOYING"));

    const pending = SandboxInstance.create({ name: "slow" });
    const expectation = expect(pending).rejects.toBe(EDGE_504_BODY);
    // Capped backoff needs the last 5s tick past the 120s deadline to land.
    await vi.advanceTimersByTimeAsync(130_000);

    await expectation;
  });

  it("throws when the sandbox lands FAILED after the create 504", async () => {
    mockedCreate.mockResolvedValueOnce(edge504());
    mockedGet.mockResolvedValueOnce(record("FAILED"));

    const pending = SandboxInstance.create({ name: "slow" });
    const expectation = expect(pending).rejects.toThrow(/failed to deploy/);
    await vi.advanceTimersByTimeAsync(1_000);

    await expectation;
  });

  it("rethrows non-504 create errors untouched without polling", async () => {
    const conflict = { code: 409, message: "already exists" };
    mockedCreate.mockResolvedValueOnce(
      ({ error: conflict, response: { status: 409 }, request: {} }) as never,
    );

    await expect(SandboxInstance.create({ name: "slow" })).rejects.toBe(conflict);
    expect(mockedGet).not.toHaveBeenCalled();
  });
});
