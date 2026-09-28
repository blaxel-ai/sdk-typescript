import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../@blaxel/core/src/client/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../@blaxel/core/src/client/index.js")>();
  return { ...actual, createSandbox: vi.fn(), getSandbox: vi.fn() };
});

import { createSandbox } from "../../@blaxel/core/src/client/index.js";
import {
  MAX_CREATION_TIMEOUT_SECONDS,
  SandboxCreationTimeoutError,
  SandboxInstance,
  isCreationTimeoutError,
} from "../../@blaxel/core/src/sandbox/sandbox.js";

const mockedCreate = vi.mocked(createSandbox);

const created = () =>
  ({ data: { metadata: { name: "sbx" }, spec: { runtime: {} }, status: "DEPLOYED" }, response: { status: 200 }, request: {} }) as never;

const timedOut = () =>
  ({
    error: { code: "CREATION_TIMEOUT", message: "Sandbox was not ready within 10s." },
    response: { status: 408 },
    request: {},
  }) as never;

const headerOf = (call: number) => mockedCreate.mock.calls[call][0].headers as Record<string, string> | undefined;

describe("SandboxInstance.create timeout option", () => {
  beforeEach(() => {
    vi.stubEnv("BL_REGION", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mockedCreate.mockReset();
  });

  it("sends no creation timeout header by default", async () => {
    mockedCreate.mockResolvedValueOnce(created());
    await SandboxInstance.create({ name: "sbx" });
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(headerOf(0)).toBeUndefined();
  });

  it("sends the creation timeout header when timeout is set", async () => {
    mockedCreate.mockResolvedValueOnce(created());
    await SandboxInstance.create({ name: "sbx" }, { timeout: 10 });
    expect(headerOf(0)).toEqual({ "X-Blaxel-Creation-Timeout": "10" });
  });

  it("rejects a timeout above the cap, non-integers and non-positive values", async () => {
    await expect(SandboxInstance.create({ name: "sbx" }, { timeout: MAX_CREATION_TIMEOUT_SECONDS + 1 })).rejects.toThrow(/between 1 and 50/);
    await expect(SandboxInstance.create({ name: "sbx" }, { timeout: 0 })).rejects.toThrow(/between 1 and 50/);
    await expect(SandboxInstance.create({ name: "sbx" }, { timeout: 2.5 })).rejects.toThrow(/whole number/);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("accepts the cap itself", async () => {
    mockedCreate.mockResolvedValueOnce(created());
    await SandboxInstance.create({ name: "sbx" }, { timeout: MAX_CREATION_TIMEOUT_SECONDS });
    expect(headerOf(0)).toEqual({ "X-Blaxel-Creation-Timeout": "50" });
  });

  it("throws a SandboxCreationTimeoutError on 408 CREATION_TIMEOUT, without retrying", async () => {
    mockedCreate.mockResolvedValueOnce(timedOut());
    const err = await SandboxInstance.create({ name: "sbx" }, { timeout: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxCreationTimeoutError);
    expect(isCreationTimeoutError(err)).toBe(true);
    expect(err).toMatchObject({ code: "CREATION_TIMEOUT", status: 408, sandboxName: "sbx", timeout: 10 });
    expect((err as Error).message).toMatch(/Sandbox sbx was not ready within 10s/);
    expect(mockedCreate).toHaveBeenCalledTimes(1);
  });

  it("recognizes the timeout by status alone when the body has no code", async () => {
    mockedCreate.mockResolvedValueOnce({ error: { message: "timeout" }, response: { status: 408 }, request: {} } as never);
    await expect(SandboxInstance.create({ name: "sbx" })).rejects.toBeInstanceOf(SandboxCreationTimeoutError);
  });

  it("does not wrap errors other than a creation timeout", async () => {
    mockedCreate.mockResolvedValueOnce({ error: { code: 409 }, response: { status: 409 }, request: {} } as never);
    const err = await SandboxInstance.create({ name: "sbx" }, { timeout: 10 }).catch((e: unknown) => e);
    expect(isCreationTimeoutError(err)).toBe(false);
    expect(err).toMatchObject({ code: 409 });
  });

  it("lets the caller retry a timed out creation", async () => {
    mockedCreate.mockResolvedValueOnce(timedOut()).mockResolvedValueOnce(created());
    let instance: SandboxInstance | undefined;
    for (let attempt = 0; attempt < 2 && !instance; attempt++) {
      try {
        instance = await SandboxInstance.create({ name: "sbx" }, { timeout: 10 });
      } catch (e) {
        if (!isCreationTimeoutError(e)) throw e;
      }
    }
    expect(instance?.status).toBe("DEPLOYED");
    expect(mockedCreate).toHaveBeenCalledTimes(2);
  });

  it("forwards timeout through createIfNotExists and surfaces its timeout error", async () => {
    mockedCreate.mockResolvedValueOnce(created());
    await SandboxInstance.createIfNotExists({ name: "sbx" }, { timeout: 5 });
    expect(mockedCreate.mock.calls[0][0].query).toEqual({ createIfNotExist: true });
    expect(headerOf(0)).toEqual({ "X-Blaxel-Creation-Timeout": "5" });

    mockedCreate.mockReset();
    mockedCreate.mockResolvedValueOnce(timedOut());
    await expect(SandboxInstance.createIfNotExists({ name: "sbx" }, { timeout: 5 })).rejects.toBeInstanceOf(SandboxCreationTimeoutError);
    expect(mockedCreate).toHaveBeenCalledTimes(1);
  });
});
