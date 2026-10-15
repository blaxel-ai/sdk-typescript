import {
  getBlaxelErrorCode,
  getBlaxelErrorMessage,
  getBlaxelErrorRequestId,
  getBlaxelErrorStatus,
  isBlaxelError,
  ResponseError,
  SandboxInstance,
} from "@blaxel/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultImage, defaultLabels, defaultRegion, uniqueName, waitForSandboxDeletion } from "./helpers.js";

// Verify the additive helpers on current wire responses; errors stay unwrapped.
describe("API error types over current thrown values", () => {
  const name = uniqueName("error-types");
  let sandbox: SandboxInstance;

  beforeAll(async () => {
    sandbox = await SandboxInstance.create({
      name, image: defaultImage, region: defaultRegion, memory: 2048,
      labels: defaultLabels, ttl: "5m",
    });
  }, 45_000);

  afterAll(async () => {
    await SandboxInstance.delete(name).catch((err: unknown) => {
      if (getBlaxelErrorStatus(err) !== 404) throw err;
    });
    expect(await waitForSandboxDeletion(name, 10)).toBe(true);
    console.log(`Deleted test sandbox ${name}`);
  }, 15_000);

  it("reads the raw control-plane body for a missing sandbox", async () => {
    const err: unknown = await SandboxInstance.get(uniqueName("missing-errors")).catch((err: unknown) => err);
    expect(err).not.toBeInstanceOf(Error);
    expect(err).toMatchObject({ code: 404 });
    expect(err).toHaveProperty("error");
    expect(isBlaxelError(err)).toBe(true);
    expect(getBlaxelErrorCode(err)).toBe(404);
    expect(getBlaxelErrorStatus(err)).toBe(404);
    expect(getBlaxelErrorMessage(err)).toEqual(expect.any(String));
    expect(getBlaxelErrorRequestId(err)).toBeUndefined();
    expect(structuredClone(err)).toEqual(err);
  }, 15_000);

  it("reads the string code and status_code of a raw sandbox-create error", async () => {
    const err: unknown = await SandboxInstance.create({
      name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
    }).catch((err: unknown) => err);
    expect(err).not.toBeInstanceOf(Error);
    expect(err).toMatchObject({ code: "SANDBOX_ALREADY_EXISTS", status_code: 409 });
    expect(isBlaxelError(err)).toBe(true);
    expect(getBlaxelErrorCode(err)).toBe("SANDBOX_ALREADY_EXISTS");
    expect(getBlaxelErrorStatus(err)).toBe(409);
    expect(getBlaxelErrorMessage(err)).toEqual(expect.any(String));
    expect(getBlaxelErrorRequestId(err)).toBeUndefined();
  }, 15_000);

  it("reads an existing sandbox ResponseError and its retained response headers", async () => {
    const err: unknown = await sandbox.fs.read("/pm2046/does-not-exist.txt").catch((err: unknown) => err);
    expect(err).toBeInstanceOf(ResponseError);
    expect(isBlaxelError(err)).toBe(true);
    expect(getBlaxelErrorStatus(err)).toBe(404);
    const responseError = err as ResponseError;
    expect(getBlaxelErrorMessage(err)).toBe(responseError.message);
    const requestId = ["x-cf-request-id", "x-amz-cf-id", "cf-ray"]
      .map((header) => responseError.response.headers.get(header)).find(Boolean) ?? undefined;
    expect(getBlaxelErrorRequestId(err)).toBe(requestId);
    expect(Object.keys(err as object)).not.toContain("requestId");
  }, 15_000);

  it("recognizes API errors but not local errors", async () => {
    const apiError: unknown = await sandbox.fs.read("/pm2046/does-not-exist.txt").catch((err: unknown) => err);
    expect(isBlaxelError(apiError)).toBe(true);
    expect(isBlaxelError(new Error("boom"))).toBe(false);
    expect(isBlaxelError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(false);
    expect(isBlaxelError("boom")).toBe(false);
  }, 15_000);
});
