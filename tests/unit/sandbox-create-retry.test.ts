import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../@blaxel/core/src/client/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../@blaxel/core/src/client/index.js")>();
  return { ...actual, createSandbox: vi.fn(), getSandbox: vi.fn() };
});

import { createSandbox } from "../../@blaxel/core/src/client/index.js";
import { SandboxCreationTimeoutError, SandboxInstance } from "../../@blaxel/core/src/sandbox/sandbox.js";

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

describe("SandboxInstance.create retry option", () => {
  beforeEach(() => {
    vi.stubEnv("BL_REGION", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mockedCreate.mockReset();
  });

  it("rejects retry without timeout", async () => {
    // @ts-expect-error retry requires timeout at the type level too
    await expect(SandboxInstance.create({ name: "sbx" }, { retry: 2 })).rejects.toThrow(/requires 'timeout'/);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("rejects retry without timeout through createIfNotExists", async () => {
    // @ts-expect-error retry requires timeout at the type level too
    await expect(SandboxInstance.createIfNotExists({ name: "sbx" }, { retry: 2 })).rejects.toThrow(/requires 'timeout'/);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("rejects negative and fractional retry values", async () => {
    await expect(SandboxInstance.create({ name: "sbx" }, { timeout: 10, retry: -1 })).rejects.toThrow(/non-negative whole number/);
    await expect(SandboxInstance.create({ name: "sbx" }, { timeout: 10, retry: 1.5 })).rejects.toThrow(/non-negative whole number/);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("retries a timed out creation up to `retry` times and resolves on success", async () => {
    mockedCreate
      .mockResolvedValueOnce(timedOut())
      .mockResolvedValueOnce(timedOut())
      .mockResolvedValueOnce(created());
    const instance = await SandboxInstance.create({ name: "sbx" }, { timeout: 10, retry: 2 });
    expect(instance.status).toBe("DEPLOYED");
    expect(mockedCreate).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) expect(headerOf(i)).toEqual({ "X-Blaxel-Creation-Timeout": "10" });
  });

  it("throws a SandboxCreationTimeoutError once retries are exhausted", async () => {
    mockedCreate.mockResolvedValue(timedOut());
    await expect(SandboxInstance.create({ name: "sbx" }, { timeout: 10, retry: 1 })).rejects.toBeInstanceOf(SandboxCreationTimeoutError);
    expect(mockedCreate).toHaveBeenCalledTimes(2);
  });

  it("does not retry with retry: 0, nor on errors other than a creation timeout", async () => {
    mockedCreate.mockResolvedValueOnce(timedOut());
    await expect(SandboxInstance.create({ name: "sbx" }, { timeout: 10, retry: 0 })).rejects.toBeInstanceOf(SandboxCreationTimeoutError);
    expect(mockedCreate).toHaveBeenCalledTimes(1);

    mockedCreate.mockReset();
    mockedCreate.mockResolvedValueOnce({ error: { code: 409 }, response: { status: 409 }, request: {} } as never);
    await expect(SandboxInstance.create({ name: "sbx" }, { timeout: 10, retry: 3 })).rejects.toMatchObject({ code: 409 });
    expect(mockedCreate).toHaveBeenCalledTimes(1);
  });

  it("forwards retry through createIfNotExists", async () => {
    mockedCreate.mockResolvedValueOnce(timedOut()).mockResolvedValueOnce(created());
    await SandboxInstance.createIfNotExists({ name: "sbx" }, { timeout: 5, retry: 1 });
    expect(mockedCreate).toHaveBeenCalledTimes(2);
    expect(mockedCreate.mock.calls[1][0].query).toEqual({ createIfNotExist: true });
    expect(headerOf(1)).toEqual({ "X-Blaxel-Creation-Timeout": "5" });
  });
});
