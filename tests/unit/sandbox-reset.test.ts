import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

// Mock the generated client so the two writes of a reset and the reads it polls
// can be scripted. sandbox.ts imports the same module, so vitest rewires both.
vi.mock("../../@blaxel/core/src/client/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../@blaxel/core/src/client/index.js")>();
  return { ...actual, getSandbox: vi.fn(), updateSandbox: vi.fn() };
});

import { getSandbox, updateSandbox } from "../../@blaxel/core/src/client/index.js";
import { ResponseError } from "../../@blaxel/core/src/sandbox/action.js";
import { SandboxFileSystem } from "../../@blaxel/core/src/sandbox/filesystem/index.js";
import { SandboxInstance } from "../../@blaxel/core/src/sandbox/sandbox.js";

// The readiness check that follows DEPLOYED: a listing of the root directory.
let ls: MockInstance<SandboxFileSystem["ls"]>;

// What the sandbox answers while its route is not up yet, right after DEPLOYED.
const notRoutable = () =>
  new ResponseError(
    { status: 404, statusText: "" } as Response,
    undefined,
    { error: { code: "WORKLOAD_UNAVAILABLE", retryable: true } },
  );

const mockedGet = vi.mocked(getSandbox);
const mockedUpdate = vi.mocked(updateSandbox);

// The control plane masks secret values when it returns a sandbox.
const envs = [{ name: "TOKEN", value: "****", secret: true }];

const record = (status: string, enabled = true) => ({
  metadata: { name: "my-sandbox", labels: { team: "a" } },
  spec: { enabled, region: "us-was-1", runtime: { image: "blaxel/base-image:latest", memory: 2048, envs }, volumes: [{ name: "data", mountPath: "/data" }] },
  status,
});

const bodyOf = (call: number) =>
  (mockedUpdate.mock.calls[call][0] as unknown as { body: ReturnType<typeof record> }).body;

describe("SandboxInstance.reset", () => {
  beforeEach(() => {
    ls = vi.spyOn(SandboxFileSystem.prototype, "ls").mockResolvedValue({} as never);
  });

  afterEach(() => {
    ls.mockRestore();
    mockedGet.mockReset();
    mockedUpdate.mockReset();
  });

  it("switches the sandbox off and on, then waits until it is deployed again", async () => {
    mockedGet
      .mockResolvedValueOnce({ data: record("DEPLOYED") } as never) // entry read
      .mockResolvedValueOnce({ data: record("DEPLOYING") } as never)
      .mockResolvedValueOnce({ data: record("DEPLOYED") } as never);
    mockedUpdate
      .mockResolvedValueOnce({ data: record("DEACTIVATED", false) } as never)
      .mockResolvedValueOnce({ data: record("DEPLOYING") } as never);

    const instance = await SandboxInstance.reset("my-sandbox", { interval: 0 });

    expect(instance.status).toBe("DEPLOYED");
    expect(instance.metadata.name).toBe("my-sandbox");
    expect(mockedUpdate).toHaveBeenCalledTimes(2);
    const [off, on] = [bodyOf(0), bodyOf(1)];
    expect(off.spec.enabled).toBe(false);
    expect(on.spec.enabled).toBe(true);
    // Everything else is written back as the control plane returned it, masked
    // secret values included, so nothing but `enabled` changes.
    expect({ ...off.spec, enabled: true }).toEqual(record("DEPLOYED").spec);
    expect({ ...on.spec }).toEqual(record("DEPLOYED").spec);
    expect(off.metadata).toEqual(record("DEPLOYED").metadata);
    // Read-only state is not sent back.
    expect(off).not.toHaveProperty("status");
    expect(mockedGet).toHaveBeenCalledTimes(3);
  });

  it("targets the sandbox by name on every call", async () => {
    mockedGet.mockResolvedValue({ data: record("DEPLOYED") } as never);
    mockedUpdate
      .mockResolvedValueOnce({ data: record("DEACTIVATED", false) } as never)
      .mockResolvedValueOnce({ data: record("DEPLOYING") } as never);

    await SandboxInstance.reset("my-sandbox", { interval: 0 });

    for (const call of [...mockedGet.mock.calls, ...mockedUpdate.mock.calls]) {
      expect((call[0] as { path: { sandboxName: string } }).path.sandboxName).toBe("my-sandbox");
    }
  });

  it("refreshes the instance it is called on and returns it", async () => {
    mockedGet
      .mockResolvedValueOnce({ data: record("DEPLOYED") } as never)
      .mockResolvedValueOnce({ data: { ...record("DEPLOYED"), lastUsedAt: "after" } } as never);
    mockedUpdate
      .mockResolvedValueOnce({ data: record("DEACTIVATED", false) } as never)
      .mockResolvedValueOnce({ data: record("DEPLOYING") } as never);

    const sandbox = new SandboxInstance(record("DEPLOYED") as never);
    const result = await sandbox.reset({ interval: 0 });

    expect(result).toBe(sandbox);
    expect(sandbox.lastUsedAt).toBe("after");
  });

  it.each(["TERMINATED", "DELETING", "ARCHIVED", "ARCHIVING", "UNARCHIVING"])(
    "refuses a %s sandbox before writing anything",
    async (status) => {
      // A write to a deleted record would bring the sandbox back to life.
      mockedGet.mockResolvedValueOnce({ data: record(status) } as never);

      await expect(SandboxInstance.reset("my-sandbox", { interval: 0 })).rejects.toThrow(
        new RegExp(`is ${status} and cannot be reset`),
      );
      expect(mockedUpdate).not.toHaveBeenCalled();
    },
  );

  it("propagates the error of a sandbox that does not exist", async () => {
    mockedGet.mockRejectedValueOnce({ code: 404, error: "Sandbox not found" });

    await expect(SandboxInstance.reset("my-sandbox")).rejects.toMatchObject({ code: 404 });
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("only switches a disabled sandbox back on", async () => {
    mockedGet
      .mockResolvedValueOnce({ data: record("DEACTIVATED", false) } as never)
      .mockResolvedValueOnce({ data: record("DEPLOYED") } as never);
    mockedUpdate.mockResolvedValueOnce({ data: record("DEPLOYING") } as never);

    const instance = await SandboxInstance.reset("my-sandbox", { interval: 0 });

    expect(instance.status).toBe("DEPLOYED");
    expect(mockedUpdate).toHaveBeenCalledTimes(1);
    expect(bodyOf(0).spec.enabled).toBe(true);
  });

  it("completes the reset of a sandbox a failed reset left DEACTIVATED", async () => {
    mockedGet
      .mockResolvedValueOnce({ data: record("DEACTIVATING", true) } as never)
      .mockResolvedValueOnce({ data: record("DEPLOYED") } as never);
    mockedUpdate.mockResolvedValueOnce({ data: record("DEPLOYING") } as never);

    await SandboxInstance.reset("my-sandbox", { interval: 0 });

    expect(mockedUpdate).toHaveBeenCalledTimes(1);
    expect(bodyOf(0).spec.enabled).toBe(true);
  });

  it("leaves the sandbox as it was when it cannot be taken down", async () => {
    mockedGet.mockResolvedValueOnce({ data: record("DEPLOYED") } as never);
    mockedUpdate.mockRejectedValueOnce({ code: 403, error: "not allowed" });

    const failure = SandboxInstance.reset("my-sandbox", { interval: 0 });

    await expect(failure).rejects.toThrow(/could not be reset, it was left as it was: not allowed \(403\)/);
    await expect(failure).rejects.toMatchObject({ cause: { code: 403 } });
    expect(mockedUpdate).toHaveBeenCalledTimes(1);
  });

  it("lets the teardown finish before it switches the sandbox back on", async () => {
    mockedGet
      .mockResolvedValueOnce({ data: record("DEPLOYED") } as never) // entry read
      .mockResolvedValueOnce({ data: record("DEACTIVATING", false) } as never)
      .mockResolvedValueOnce({ data: record("DEACTIVATED", false) } as never)
      .mockResolvedValueOnce({ data: record("DEPLOYED") } as never);
    mockedUpdate
      .mockResolvedValueOnce({ data: record("DEACTIVATING", false) } as never)
      .mockResolvedValueOnce({ data: record("DEPLOYING") } as never);

    const instance = await SandboxInstance.reset("my-sandbox", { interval: 0 });

    expect(instance.status).toBe("DEPLOYED");
    // The write that switches it on comes after the sandbox read DEACTIVATED.
    expect(mockedUpdate).toHaveBeenCalledTimes(2);
    expect(mockedGet.mock.invocationCallOrder[2]).toBeLessThan(mockedUpdate.mock.invocationCallOrder[1]);
    expect(bodyOf(1).spec.enabled).toBe(true);
  });

  it("does not switch it back on when the teardown ends up somewhere else", async () => {
    mockedGet
      .mockResolvedValueOnce({ data: record("DEPLOYED") } as never)
      .mockResolvedValueOnce({ data: record("DEPLOYED") } as never);
    mockedUpdate.mockResolvedValueOnce({ data: record("DEACTIVATING", false) } as never);

    await expect(SandboxInstance.reset("my-sandbox", { interval: 0 })).rejects.toThrow(
      /did not finish taking it down \(it is DEPLOYED\)/,
    );
    expect(mockedUpdate).toHaveBeenCalledTimes(1);
  });

  it("does not switch it back on when the control plane did not take it down", async () => {
    mockedGet.mockResolvedValueOnce({ data: record("DEPLOYED") } as never);
    mockedUpdate.mockResolvedValueOnce({ data: record("DEPLOYED") } as never);

    await expect(SandboxInstance.reset("my-sandbox", { interval: 0 })).rejects.toThrow(
      /did not take it down \(it is DEPLOYED\)/,
    );
    expect(mockedUpdate).toHaveBeenCalledTimes(1);
  });

  it("says the sandbox is left DEACTIVATED, and how to bring it back, when it cannot be switched on", async () => {
    mockedGet.mockResolvedValueOnce({ data: record("DEPLOYED") } as never);
    mockedUpdate
      .mockResolvedValueOnce({ data: record("DEACTIVATED", false) } as never)
      .mockRejectedValueOnce({ code: 500, error: "internal" });

    const failure = SandboxInstance.reset("my-sandbox", { interval: 0 });

    await expect(failure).rejects.toThrow(/left DEACTIVATED; call SandboxInstance\.reset\("my-sandbox"\) again/);
    await expect(failure).rejects.toMatchObject({ cause: { code: 500 } });
  });

  it("retries the write that switches it back on after a dropped connection", async () => {
    mockedGet
      .mockResolvedValueOnce({ data: record("DEPLOYED") } as never)
      .mockResolvedValueOnce({ data: record("DEPLOYED") } as never);
    mockedUpdate
      .mockResolvedValueOnce({ data: record("DEACTIVATED", false) } as never)
      .mockRejectedValueOnce(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce({ data: record("DEPLOYING") } as never);

    const instance = await SandboxInstance.reset("my-sandbox", { interval: 0 });

    expect(instance.status).toBe("DEPLOYED");
    expect(mockedUpdate).toHaveBeenCalledTimes(3);
    expect(bodyOf(2).spec.enabled).toBe(true);
  });

  it("throws when the sandbox fails to deploy again", async () => {
    mockedGet
      .mockResolvedValueOnce({ data: record("DEPLOYED") } as never)
      .mockResolvedValueOnce({ data: record("FAILED") } as never);
    mockedUpdate
      .mockResolvedValueOnce({ data: record("DEACTIVATED", false) } as never)
      .mockResolvedValueOnce({ data: record("DEPLOYING") } as never);

    await expect(SandboxInstance.reset("my-sandbox", { interval: 0 })).rejects.toThrow(/failed to deploy again/);
  });

  it("tolerates the record still reading off right after the switch-on write", async () => {
    mockedGet
      .mockResolvedValueOnce({ data: record("DEPLOYED") } as never)
      .mockResolvedValueOnce({ data: record("DEACTIVATED", false) } as never)
      .mockResolvedValueOnce({ data: record("DEACTIVATING", false) } as never)
      .mockResolvedValueOnce({ data: record("DEPLOYING") } as never)
      .mockResolvedValueOnce({ data: record("DEPLOYED") } as never);
    mockedUpdate
      .mockResolvedValueOnce({ data: record("DEACTIVATED", false) } as never)
      .mockResolvedValueOnce({ data: record("DEACTIVATED", true) } as never);

    const instance = await SandboxInstance.reset("my-sandbox", { interval: 0 });

    expect(instance.status).toBe("DEPLOYED");
    expect(mockedGet).toHaveBeenCalledTimes(5);
  });

  it("does not tolerate a sandbox that stays off, within the wait asked for", async () => {
    mockedGet.mockResolvedValue({ data: record("DEACTIVATED", false) } as never);
    mockedGet.mockResolvedValueOnce({ data: record("DEPLOYED") } as never);
    mockedUpdate
      .mockResolvedValueOnce({ data: record("DEACTIVATED", false) } as never)
      .mockResolvedValueOnce({ data: record("DEACTIVATED", true) } as never);

    await expect(SandboxInstance.reset("my-sandbox", { interval: 0, maxWait: 0 })).rejects.toThrow(
      /is DEACTIVATED while it should be deployed again/,
    );
  });

  it("throws when the sandbox is taken down again once it is redeploying", async () => {
    mockedGet
      .mockResolvedValueOnce({ data: record("DEPLOYED") } as never)
      .mockResolvedValueOnce({ data: record("DEPLOYING") } as never)
      .mockResolvedValueOnce({ data: record("DEACTIVATED", false) } as never);
    mockedUpdate
      .mockResolvedValueOnce({ data: record("DEACTIVATED", false) } as never)
      .mockResolvedValueOnce({ data: record("DEPLOYING") } as never);

    await expect(SandboxInstance.reset("my-sandbox", { interval: 0 })).rejects.toThrow(
      /is DEACTIVATED while it should be deployed again/,
    );
  });

  it("gives up after maxWait", async () => {
    mockedGet.mockResolvedValue({ data: record("DEPLOYING") } as never);
    mockedGet.mockResolvedValueOnce({ data: record("DEPLOYED") } as never);
    mockedUpdate
      .mockResolvedValueOnce({ data: record("DEACTIVATED", false) } as never)
      .mockResolvedValueOnce({ data: record("DEPLOYING") } as never);

    await expect(SandboxInstance.reset("my-sandbox", { interval: 0, maxWait: 0 })).rejects.toThrow(
      /still DEPLOYING after waiting 0s/,
    );
  });

  it("waits until the sandbox answers, not only until it is DEPLOYED", async () => {
    // The record is DEPLOYED a couple of seconds before the route is up.
    mockedGet
      .mockResolvedValueOnce({ data: record("DEPLOYED") } as never)
      .mockResolvedValueOnce({ data: record("DEPLOYED") } as never);
    mockedUpdate
      .mockResolvedValueOnce({ data: record("DEACTIVATED", false) } as never)
      .mockResolvedValueOnce({ data: record("DEPLOYING") } as never);
    ls.mockRejectedValueOnce(notRoutable()).mockRejectedValueOnce(notRoutable()).mockResolvedValueOnce({} as never);

    const instance = await SandboxInstance.reset("my-sandbox", { interval: 0 });

    expect(instance.status).toBe("DEPLOYED");
    expect(ls).toHaveBeenCalledTimes(3);
    // The record is read once: the readiness check does not poll it again.
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it("throws when a deployed sandbox does not answer in time", async () => {
    mockedGet.mockResolvedValue({ data: record("DEPLOYED") } as never);
    mockedUpdate
      .mockResolvedValueOnce({ data: record("DEACTIVATED", false) } as never)
      .mockResolvedValueOnce({ data: record("DEPLOYING") } as never);
    ls.mockRejectedValue(notRoutable());

    const failure = SandboxInstance.reset("my-sandbox", { interval: 0, maxWait: 0 });

    await expect(failure).rejects.toThrow(/was deployed again but did not answer within 0s/);
    await expect(failure).rejects.toMatchObject({ cause: { status: 404 } });
  });

  it("does not keep waiting on an error that retrying cannot fix", async () => {
    mockedGet.mockResolvedValue({ data: record("DEPLOYED") } as never);
    mockedUpdate
      .mockResolvedValueOnce({ data: record("DEACTIVATED", false) } as never)
      .mockResolvedValueOnce({ data: record("DEPLOYING") } as never);
    ls.mockRejectedValue(new ResponseError({ status: 403, statusText: "" } as Response, undefined, { error: "forbidden" }));

    await expect(SandboxInstance.reset("my-sandbox", { interval: 0 })).rejects.toThrow(
      /was deployed again but does not answer after the reset: .*403/,
    );
    expect(ls).toHaveBeenCalledTimes(1);
  });
});
