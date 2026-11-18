import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the generated client so create/get can be scripted per test. sandbox.ts
// imports the same module ("../client/index.js"), so vitest rewires both.
vi.mock("../../@blaxel/core/src/client/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../@blaxel/core/src/client/index.js")>();
  return { ...actual, createSandbox: vi.fn(), getSandbox: vi.fn() };
});

import { createSandbox, getSandbox } from "../../@blaxel/core/src/client/index.js";
import { getBlaxelErrorCode, isBlaxelError } from "../../@blaxel/core/src/common/error-types.js";
import { SandboxInstance } from "../../@blaxel/core/src/sandbox/sandbox.js";

const mockedCreate = vi.mocked(createSandbox);
const mockedGet = vi.mocked(getSandbox);

// What hey-api returns (without throwOnError) when CloudFront cuts the origin
// connection at 60s: an HTML body, no parsable JSON error payload.
const EDGE_504_BODY = "<html><body>504 Gateway Time-out</body></html>";
const edge504 = () =>
  ({ error: EDGE_504_BODY, response: { status: 504 }, request: {} }) as never;

const record = (status: string, extra: Record<string, unknown> = {}) =>
  ({ data: { metadata: { name: "slow" }, spec: { runtime: {} }, status, ...extra } }) as never;

// A create the API answered before the sandbox was ready: 202 with the sandbox,
// named by the server when the request had no name, still DEPLOYING.
const accepted = (name = "slow") =>
  ({ data: { metadata: { name }, spec: { runtime: {} }, status: "DEPLOYING" }, response: { status: 202 }, request: {} }) as never;

const created = (status: string) =>
  ({ data: { metadata: { name: "slow" }, spec: { runtime: {} }, status }, response: { status: 200 }, request: {} }) as never;

describe("SandboxInstance.create 504 gateway-timeout handling (ENG-3662)", () => {
  beforeEach(() => {
    // Keep edgeDomain null so create() skips the real H2 warm-up path.
    vi.stubEnv("BL_REGION", "");
    vi.useFakeTimers();
    // Zero the backoff jitter so poll delays are exactly 0.5s, 1s, 2s, 3s, ...
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
    // Backoff polls at +0.5s then +1s.
    await vi.advanceTimersByTimeAsync(1_500);

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
    // Capped backoff needs the last 3s tick past the 240s deadline to land.
    await vi.advanceTimersByTimeAsync(245_000);

    await expectation;
  });

  it("throws when the sandbox lands FAILED after the create 504", async () => {
    mockedCreate.mockResolvedValueOnce(edge504());
    mockedGet.mockResolvedValueOnce(record("FAILED"));

    const pending = SandboxInstance.create({ name: "slow" });
    const expectation = expect(pending).rejects.toMatchObject({
      code: "DEPLOYMENT_FAILED",
      message: "Sandbox slow failed to deploy.",
      status_code: 500,
    });
    await vi.advanceTimersByTimeAsync(500);

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

describe("SandboxInstance.create 202 Accepted handling", () => {
  beforeEach(() => {
    vi.stubEnv("BL_REGION", "");
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    mockedCreate.mockReset();
    mockedGet.mockReset();
  });

  it("waits until the sandbox is DEPLOYED, reading it by the name the 202 body carries", async () => {
    // No name in the request: the server assigned "slow".
    mockedCreate.mockResolvedValueOnce(accepted("slow"));
    mockedGet
      .mockResolvedValueOnce(record("DEPLOYING"))
      .mockResolvedValueOnce(record("DEPLOYED"));

    const pending = SandboxInstance.create({ image: "custom:latest" });
    await vi.advanceTimersByTimeAsync(1_500);

    const instance = await pending;
    expect(instance).toBeInstanceOf(SandboxInstance);
    expect(instance.status).toBe("DEPLOYED");
    expect(instance.metadata.name).toBe("slow");
    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(mockedGet).toHaveBeenCalledWith(expect.objectContaining({ path: { sandboxName: "slow" } }));
  });

  it("throws DEPLOYMENT_FAILED with the reason the control plane recorded when the sandbox ends FAILED", async () => {
    mockedCreate.mockResolvedValueOnce(accepted());
    mockedGet.mockResolvedValueOnce(record("FAILED", {
      events: [
        { status: "DEPLOYING", message: "Deploying" },
        { status: "FAILED", message: "Sandbox was not ready within 3m0s. Its resources were released; please try again." },
      ],
    }));

    const pending = SandboxInstance.create({ name: "slow" });
    const failure = pending.then(() => undefined, (err: unknown) => err);
    await vi.advanceTimersByTimeAsync(500);

    const err = await failure;
    // The same typed body a create the API rejects outright is thrown with.
    expect(err).toEqual({
      code: "DEPLOYMENT_FAILED",
      message: "Sandbox slow failed to deploy: Sandbox was not ready within 3m0s. Its resources were released; please try again.",
      status_code: 500,
      sandbox_name: "slow",
    });
    expect(isBlaxelError(err)).toBe(true);
    expect(getBlaxelErrorCode(err)).toBe("DEPLOYMENT_FAILED");
  });

  it("throws once the wait is spent, saying the sandbox is still DEPLOYING", async () => {
    mockedCreate.mockResolvedValueOnce(accepted());
    mockedGet.mockResolvedValue(record("DEPLOYING"));

    const pending = SandboxInstance.create({ name: "slow" });
    let settled = false;
    pending.catch(() => {}).finally(() => { settled = true; });
    const expectation = expect(pending).rejects.toThrow(/^Sandbox slow is still DEPLOYING 240s after it was created/);

    // Still waiting well past the server's 3-minute creation deadline.
    await vi.advanceTimersByTimeAsync(200_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(45_000);

    await expectation;
  });

  it.each(["DEPLOYED", "DEPLOYING", "BUILDING"])("returns a 200 create as it is, without reading the sandbox (%s)", async (status) => {
    mockedCreate.mockResolvedValueOnce(created(status));

    const instance = await SandboxInstance.create({ name: "slow" });

    expect(instance.status).toBe(status);
    expect(mockedGet).not.toHaveBeenCalled();
  });
});
