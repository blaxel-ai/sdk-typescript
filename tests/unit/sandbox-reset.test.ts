import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

// Mock the generated clients so the calls of a reset can be scripted: the
// control plane's record reads and writes, and the sandbox's health route.
// sandbox.ts imports the same modules, so vitest rewires both.
vi.mock("../../@blaxel/core/src/client/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../@blaxel/core/src/client/index.js")>();
  return { ...actual, getSandbox: vi.fn(), updateSandbox: vi.fn() };
});
vi.mock("../../@blaxel/core/src/sandbox/client/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../@blaxel/core/src/sandbox/client/index.js")>();
  return { ...actual, getHealth: vi.fn() };
});

import { client as controlPlaneClient } from "../../@blaxel/core/src/client/client.gen.js";
import { getSandbox, updateSandbox } from "../../@blaxel/core/src/client/index.js";
import { getHealth } from "../../@blaxel/core/src/sandbox/client/index.js";
import { SandboxInstance } from "../../@blaxel/core/src/sandbox/sandbox.js";

const mockedGet = vi.mocked(getSandbox);
const mockedUpdate = vi.mocked(updateSandbox);
const mockedHealth = vi.mocked(getHealth);
let post: MockInstance<typeof controlPlaneClient.post>;

const response = (status: number) => ({ ok: status >= 200 && status < 300, status, statusText: "" }) as Response;

// The control plane masks secret values when it returns a sandbox.
const envs = [{ name: "TOKEN", value: "****", secret: true }];
const CREATED_AT = "2026-10-19T12:00:00Z";

type Event = { type: string; status: string };
const deactivated: Event = { type: "ai.blaxel.controlplane.api.deactivate", status: "DEACTIVATED" };
const tearingDown: Event = { type: "ai.blaxel.controlplane.deployment.created", status: "DEACTIVATED" };
const tornDown: Event = { type: "ai.blaxel.controlplane.deployment.succeeded", status: "DEACTIVATED" };

const record = (status: string, enabled = true, events: Event[] = [], createdAt = CREATED_AT) => ({
  metadata: { name: "my-sandbox", labels: { team: "a" }, createdAt },
  spec: { enabled, region: "us-was-1", runtime: { image: "blaxel/base-image:latest", memory: 2048, envs }, volumes: [{ name: "data", mountPath: "/data" }] },
  status,
  events,
});
const off = (...events: Event[]) => record("DEACTIVATED", false, events);

const bodyOf = (call: number) =>
  (mockedUpdate.mock.calls[call][0] as unknown as { body: ReturnType<typeof record> }).body;

// What the control plane answers when it has the reset call, and when it has not.
const resetDone = (status = "DEPLOYED") => ({ data: record(status), error: undefined, response: response(200) });
const unknownRoute = () => ({ data: undefined, error: { code: 404, error: "Route not found" }, response: response(404) });
const refused = (code: number, error: string) => ({ data: undefined, error: { code, error }, response: response(code) });

// What the sandbox's health route answers: the instance serves it, or the
// gateway has no instance to route to yet.
const healthy = () => ({ data: { status: "ok" }, error: undefined, response: response(200) });
const notRoutable = () => ({ data: undefined, error: { error: { code: "WORKLOAD_UNAVAILABLE" } }, response: response(404) });

// A call that only ends when the reset gives up on it.
const hangsUntilAborted = (options: unknown) =>
  new Promise((_, reject) => {
    const signal = (options as { signal?: AbortSignal }).signal;
    signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });

describe("SandboxInstance.reset", () => {
  beforeEach(() => {
    post = vi.spyOn(controlPlaneClient, "post");
    mockedHealth.mockResolvedValue(healthy() as never);
  });

  afterEach(() => {
    post.mockRestore();
    mockedGet.mockReset();
    mockedUpdate.mockReset();
    mockedHealth.mockReset();
  });

  describe("on a control plane with the reset call", () => {
    it("resets the sandbox in one call and waits until it answers", async () => {
      post.mockResolvedValueOnce(resetDone() as never);

      const instance = await SandboxInstance.reset("my-sandbox", { interval: 0 });

      expect(instance.status).toBe("DEPLOYED");
      expect(post).toHaveBeenCalledTimes(1);
      const call = post.mock.calls[0][0] as { url: string; path: { sandboxName: string } };
      expect(call.url).toBe("/sandboxes/{sandboxName}/reset");
      expect(call.path.sandboxName).toBe("my-sandbox");
      expect(mockedHealth).toHaveBeenCalledTimes(1);
      // Nothing is switched off and on.
      expect(mockedGet).not.toHaveBeenCalled();
      expect(mockedUpdate).not.toHaveBeenCalled();
    });

    it("waits for the gateway to route to the new instance", async () => {
      post.mockResolvedValueOnce(resetDone() as never);
      mockedHealth.mockResolvedValueOnce(notRoutable() as never).mockResolvedValueOnce(notRoutable() as never);

      await SandboxInstance.reset("my-sandbox", { interval: 0 });

      expect(mockedHealth).toHaveBeenCalledTimes(3);
    });

    it("refreshes the instance it is called on and returns it", async () => {
      post.mockResolvedValueOnce({ ...resetDone(), data: { ...record("DEPLOYED"), lastUsedAt: "after" } } as never);

      const sandbox = new SandboxInstance(record("DEPLOYED") as never);
      const result = await sandbox.reset({ interval: 0 });

      expect(result).toBe(sandbox);
      expect(sandbox.lastUsedAt).toBe("after");
    });

    it("propagates what the control plane refuses, without switching anything", async () => {
      post.mockResolvedValueOnce(refused(409, "This sandbox is archived, unarchive it before resetting it") as never);

      await expect(SandboxInstance.reset("my-sandbox", { interval: 0 })).rejects.toMatchObject({ code: 409 });
      expect(mockedGet).not.toHaveBeenCalled();
      expect(mockedUpdate).not.toHaveBeenCalled();
    });

    it("propagates the error of a sandbox that does not exist", async () => {
      post.mockResolvedValueOnce(refused(404, "Sandbox not found") as never);

      await expect(SandboxInstance.reset("my-sandbox")).rejects.toMatchObject({ code: 404 });
      expect(mockedUpdate).not.toHaveBeenCalled();
    });

    it("asks again after an edge error or a dropped connection", async () => {
      post
        .mockResolvedValueOnce(refused(502, "Bad Gateway") as never)
        .mockRejectedValueOnce(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))
        .mockResolvedValueOnce(resetDone() as never);

      const instance = await SandboxInstance.reset("my-sandbox", { interval: 0 });

      expect(instance.status).toBe("DEPLOYED");
      expect(post).toHaveBeenCalledTimes(3);
    });

    it("gives up waiting on the control plane at maxWait", async () => {
      post.mockImplementationOnce(hangsUntilAborted as never);

      await expect(SandboxInstance.reset("my-sandbox", { interval: 0, maxWait: 50 })).rejects.toThrow(
        /was not reset within 0s; a reset the control plane started still finishes/,
      );
    });

    it("throws when the sandbox does not answer in time", async () => {
      post.mockResolvedValueOnce(resetDone() as never);
      mockedHealth.mockResolvedValue(notRoutable() as never);

      await expect(SandboxInstance.reset("my-sandbox", { interval: 0, maxWait: 30 })).rejects.toThrow(
        /has a fresh instance but it did not answer within 0s after the reset: 404/,
      );
    });

    it("does not keep probing an answer that retrying cannot fix", async () => {
      post.mockResolvedValueOnce(resetDone() as never);
      mockedHealth.mockResolvedValue({ data: undefined, error: { error: "forbidden" }, response: response(403) } as never);

      await expect(SandboxInstance.reset("my-sandbox", { interval: 0 })).rejects.toThrow(/answered 403 after the reset/);
      expect(mockedHealth).toHaveBeenCalledTimes(1);
    });

    it("cuts every call at maxWait, and sends none without one", async () => {
      post.mockResolvedValueOnce(resetDone() as never);
      await SandboxInstance.reset("my-sandbox", { interval: 0, maxWait: 60_000 });
      expect((post.mock.calls[0][0] as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);

      post.mockResolvedValueOnce(resetDone() as never);
      await SandboxInstance.reset("my-sandbox", { interval: 0, maxWait: -1 });
      expect((post.mock.calls[1][0] as { signal?: AbortSignal }).signal).toBeUndefined();
    });
  });

  describe("on a control plane without the reset call", () => {
    beforeEach(() => {
      post.mockResolvedValue(unknownRoute() as never);
    });

    it("switches the sandbox off, waits for the platform to report it gone, and switches it back on", async () => {
      mockedGet
        .mockResolvedValueOnce({ data: record("DEPLOYED") } as never) // entry read
        .mockResolvedValueOnce({ data: off(deactivated) } as never)
        .mockResolvedValueOnce({ data: off(deactivated, tearingDown) } as never)
        .mockResolvedValueOnce({ data: off(deactivated, tearingDown, tornDown) } as never)
        .mockResolvedValueOnce({ data: record("DEPLOYING") } as never)
        .mockResolvedValueOnce({ data: record("DEPLOYED") } as never);
      mockedUpdate
        .mockResolvedValueOnce({ data: off(deactivated) } as never)
        .mockResolvedValueOnce({ data: record("DEPLOYING") } as never);

      const instance = await SandboxInstance.reset("my-sandbox", { interval: 0 });

      expect(instance.status).toBe("DEPLOYED");
      expect(mockedUpdate).toHaveBeenCalledTimes(2);
      const [offBody, onBody] = [bodyOf(0), bodyOf(1)];
      expect(offBody.spec.enabled).toBe(false);
      expect(onBody.spec.enabled).toBe(true);
      // Everything else is written back as the control plane returned it, masked
      // secret values included, so nothing but `enabled` changes.
      expect({ ...offBody.spec, enabled: true }).toEqual(record("DEPLOYED").spec);
      expect({ ...onBody.spec }).toEqual(record("DEPLOYED").spec);
      expect(offBody.metadata).toEqual(record("DEPLOYED").metadata);
      // Read-only state is not sent back.
      expect(offBody).not.toHaveProperty("status");
      expect(offBody).not.toHaveProperty("events");
      expect(mockedGet).toHaveBeenCalledTimes(6);
      // The guest is only asked whether it answers once the new instance runs.
      expect(mockedHealth).toHaveBeenCalledTimes(1);
    });

    it("does not switch it back on before the platform reports the old instance gone", async () => {
      let readsBeforeSwitchOn = -1;
      mockedGet
        .mockResolvedValueOnce({ data: record("DEPLOYED") } as never)
        .mockResolvedValueOnce({ data: off(deactivated, tearingDown) } as never)
        .mockResolvedValueOnce({ data: off(deactivated, tearingDown) } as never)
        .mockResolvedValueOnce({ data: off(deactivated, tearingDown, tornDown) } as never)
        .mockResolvedValue({ data: record("DEPLOYED") } as never);
      mockedUpdate
        .mockResolvedValueOnce({ data: off(deactivated) } as never)
        .mockImplementationOnce(() => {
          readsBeforeSwitchOn = mockedGet.mock.calls.length;
          return Promise.resolve({ data: record("DEPLOYING") } as never);
        });

      await SandboxInstance.reset("my-sandbox", { interval: 0 });

      expect(readsBeforeSwitchOn).toBe(4);
    });

    it("targets the sandbox by name on every call", async () => {
      mockedGet
        .mockResolvedValueOnce({ data: record("DEPLOYED") } as never)
        .mockResolvedValueOnce({ data: off(tornDown) } as never)
        .mockResolvedValue({ data: record("DEPLOYED") } as never);
      mockedUpdate
        .mockResolvedValueOnce({ data: off(deactivated) } as never)
        .mockResolvedValueOnce({ data: record("DEPLOYING") } as never);

      await SandboxInstance.reset("my-sandbox", { interval: 0 });

      for (const call of [...mockedGet.mock.calls, ...mockedUpdate.mock.calls]) {
        expect((call[0] as { path: { sandboxName: string } }).path.sandboxName).toBe("my-sandbox");
      }
    });

    it.each(["TERMINATED", "DELETING", "FAILED", "ARCHIVED", "ARCHIVING", "UNARCHIVING"])(
      "refuses a %s sandbox before writing anything",
      async (status) => {
        // A write to a deleted record would bring the sandbox back to life, and
        // one to a FAILED record has it released and created again.
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

    it("completes the reset of a sandbox a failed reset left DEACTIVATED", async () => {
      mockedGet
        .mockResolvedValueOnce({ data: off(deactivated, tornDown) } as never)
        .mockResolvedValueOnce({ data: off(deactivated, tornDown) } as never)
        .mockResolvedValue({ data: record("DEPLOYED") } as never);
      mockedUpdate.mockResolvedValueOnce({ data: record("DEPLOYING") } as never);

      const instance = await SandboxInstance.reset("my-sandbox", { interval: 0 });

      expect(instance.status).toBe("DEPLOYED");
      expect(mockedUpdate).toHaveBeenCalledTimes(1);
      expect(bodyOf(0).spec.enabled).toBe(true);
    });

    it("leaves the sandbox as it was when it cannot be taken down", async () => {
      mockedGet.mockResolvedValueOnce({ data: record("DEPLOYED") } as never);
      mockedUpdate.mockRejectedValueOnce({ code: 500, error: "boom" });

      await expect(SandboxInstance.reset("my-sandbox", { interval: 0 })).rejects.toThrow(
        /could not be reset, it was left as it was: boom \(500\)/,
      );
      expect(mockedUpdate).toHaveBeenCalledTimes(1);
    });

    it("does not switch it back on when the control plane did not take it down", async () => {
      mockedGet.mockResolvedValueOnce({ data: record("DEPLOYED") } as never);
      mockedUpdate.mockResolvedValueOnce({ data: record("DEPLOYED") } as never);

      await expect(SandboxInstance.reset("my-sandbox", { interval: 0 })).rejects.toThrow(/did not take it down/);
      expect(mockedUpdate).toHaveBeenCalledTimes(1);
    });

    it("does not switch it back on when the sandbox is deleted during the teardown", async () => {
      mockedGet
        .mockResolvedValueOnce({ data: record("DEPLOYED") } as never)
        .mockRejectedValueOnce({ code: 404, error: "Sandbox not found" });
      mockedUpdate.mockResolvedValueOnce({ data: off(deactivated) } as never);

      await expect(SandboxInstance.reset("my-sandbox", { interval: 0 })).rejects.toThrow(/was deleted during its reset/);
      expect(mockedUpdate).toHaveBeenCalledTimes(1);
    });

    it.each(["DELETING", "TERMINATED", "DEPLOYING"])(
      "does not switch it back on when it turns %s during the teardown",
      async (status) => {
        mockedGet
          .mockResolvedValueOnce({ data: record("DEPLOYED") } as never)
          .mockResolvedValueOnce({ data: record(status, status === "DEPLOYING", [tornDown]) } as never);
        mockedUpdate.mockResolvedValueOnce({ data: off(deactivated) } as never);

        await expect(SandboxInstance.reset("my-sandbox", { interval: 0 })).rejects.toThrow(
          new RegExp(`is ${status} while it should be switched off for the reset`),
        );
        expect(mockedUpdate).toHaveBeenCalledTimes(1);
      },
    );

    it("leaves a sandbox created again under the same name alone", async () => {
      mockedGet
        .mockResolvedValueOnce({ data: record("DEPLOYED") } as never)
        .mockResolvedValueOnce({ data: record("DEACTIVATED", false, [tornDown], "2026-10-19T12:05:00Z") } as never);
      mockedUpdate.mockResolvedValueOnce({ data: off(deactivated) } as never);

      await expect(SandboxInstance.reset("my-sandbox", { interval: 0 })).rejects.toThrow(/was deleted and created again during its reset/);
      expect(mockedUpdate).toHaveBeenCalledTimes(1);
    });

    it("says what to do, without promising that a reset finishes it, when the teardown fails", async () => {
      mockedGet
        .mockResolvedValueOnce({ data: record("DEPLOYED") } as never)
        .mockResolvedValueOnce({ data: off(deactivated, { type: "ai.blaxel.controlplane.deployment.failed", status: "FAILED" }) } as never);
      mockedUpdate.mockResolvedValueOnce({ data: off(deactivated) } as never);

      const failure = SandboxInstance.reset("my-sandbox", { interval: 0 });

      await expect(failure).rejects.toThrow(/the platform reported the teardown failed\. It is left switched off; delete it and create it again/);
      await expect(failure).rejects.not.toThrow(/call SandboxInstance\.reset/);
      expect(mockedUpdate).toHaveBeenCalledTimes(1);
    });

    it("reports a switch-off that landed on a sandbox created again under the same name", async () => {
      mockedGet.mockResolvedValueOnce({ data: record("DEPLOYED") } as never);
      mockedUpdate.mockResolvedValueOnce({ data: record("DEACTIVATED", false, [deactivated], "2026-10-19T12:05:00Z") } as never);

      await expect(SandboxInstance.reset("my-sandbox", { interval: 0 })).rejects.toThrow(
        /was deleted and created again while it was being switched off for its reset; the new sandbox was written to and is left switched off/,
      );
      expect(mockedUpdate).toHaveBeenCalledTimes(1);
    });

    it("does not write the switch-on again to a sandbox created again under the same name", async () => {
      mockedGet
        .mockResolvedValueOnce({ data: record("DEPLOYED") } as never)
        .mockResolvedValueOnce({ data: off(tornDown) } as never)
        .mockResolvedValueOnce({ data: record("DEACTIVATED", false, [tornDown], "2026-10-19T12:05:00Z") } as never);
      mockedUpdate
        .mockResolvedValueOnce({ data: off(deactivated) } as never)
        .mockRejectedValueOnce(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));

      await expect(SandboxInstance.reset("my-sandbox", { interval: 0 })).rejects.toThrow(/was deleted and created again during its reset/);
      expect(mockedUpdate).toHaveBeenCalledTimes(2);
    });

    it("does not write the switch-on twice when the first one landed before its answer was lost", async () => {
      mockedGet
        .mockResolvedValueOnce({ data: record("DEPLOYED") } as never)
        .mockResolvedValueOnce({ data: off(tornDown) } as never)
        .mockResolvedValueOnce({ data: record("DEPLOYING") } as never)
        .mockResolvedValue({ data: record("DEPLOYED") } as never);
      mockedUpdate
        .mockResolvedValueOnce({ data: off(deactivated) } as never)
        .mockRejectedValueOnce(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));

      const instance = await SandboxInstance.reset("my-sandbox", { interval: 0 });

      expect(instance.status).toBe("DEPLOYED");
      expect(mockedUpdate).toHaveBeenCalledTimes(2);
    });

    it("stops waiting for the redeploy of a sandbox created again under the same name", async () => {
      mockedGet
        .mockResolvedValueOnce({ data: record("DEPLOYED") } as never)
        .mockResolvedValueOnce({ data: off(tornDown) } as never)
        .mockResolvedValueOnce({ data: record("DEPLOYED", true, [], "2026-10-19T12:05:00Z") } as never);
      mockedUpdate
        .mockResolvedValueOnce({ data: off(deactivated) } as never)
        .mockResolvedValueOnce({ data: record("DEPLOYING") } as never);

      await expect(SandboxInstance.reset("my-sandbox", { interval: 0 })).rejects.toThrow(/was deleted and created again during its reset/);
      expect(mockedHealth).not.toHaveBeenCalled();
    });

    it("leaves the sandbox DEACTIVATED, and says how to finish, when the teardown outlives maxWait", async () => {
      mockedGet
        .mockResolvedValueOnce({ data: record("DEPLOYED") } as never)
        .mockResolvedValue({ data: off(deactivated, tearingDown) } as never);
      mockedUpdate.mockResolvedValueOnce({ data: off(deactivated) } as never);

      await expect(SandboxInstance.reset("my-sandbox", { interval: 5, maxWait: 30 })).rejects.toThrow(
        /was not reported gone within 0s, it is left DEACTIVATED; call SandboxInstance\.reset\("my-sandbox"\) again/,
      );
      expect(mockedUpdate).toHaveBeenCalledTimes(1);
    });

    it("keeps reading the record through edge errors and dropped connections", async () => {
      mockedGet
        .mockResolvedValueOnce({ data: record("DEPLOYED") } as never)
        .mockRejectedValueOnce({ code: 502, error: "Bad Gateway" })
        .mockRejectedValueOnce(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))
        .mockResolvedValueOnce({ data: off(tornDown) } as never)
        .mockResolvedValue({ data: record("DEPLOYED") } as never);
      mockedUpdate
        .mockResolvedValueOnce({ data: off(deactivated) } as never)
        .mockResolvedValueOnce({ data: record("DEPLOYING") } as never);

      const instance = await SandboxInstance.reset("my-sandbox", { interval: 0 });

      expect(instance.status).toBe("DEPLOYED");
    });

    it("cuts a read that hangs at maxWait", async () => {
      mockedGet
        .mockResolvedValueOnce({ data: record("DEPLOYED") } as never)
        .mockImplementationOnce(hangsUntilAborted as never);
      mockedUpdate.mockResolvedValueOnce({ data: off(deactivated) } as never);

      await expect(SandboxInstance.reset("my-sandbox", { interval: 0, maxWait: 80 })).rejects.toThrow(
        /could not be read again, it is left DEACTIVATED/,
      );
    });

    it("says the sandbox is left DEACTIVATED, and how to bring it back, when it cannot be switched on", async () => {
      mockedGet
        .mockResolvedValueOnce({ data: record("DEPLOYED") } as never)
        .mockResolvedValueOnce({ data: off(tornDown) } as never);
      mockedUpdate
        .mockResolvedValueOnce({ data: off(deactivated) } as never)
        .mockRejectedValueOnce({ code: 500, error: "boom" });

      const failure = SandboxInstance.reset("my-sandbox", { interval: 0 });

      await expect(failure).rejects.toThrow(/left DEACTIVATED; call SandboxInstance\.reset\("my-sandbox"\) again/);
      await expect(failure).rejects.toMatchObject({ cause: { code: 500 } });
    });

    it("writes the switch-on again, from a fresh read, after a dropped connection", async () => {
      mockedGet
        .mockResolvedValueOnce({ data: record("DEPLOYED") } as never)
        .mockResolvedValueOnce({ data: off(tornDown) } as never)
        .mockResolvedValueOnce({ data: off(tornDown) } as never) // read again before writing again
        .mockResolvedValue({ data: record("DEPLOYED") } as never);
      mockedUpdate
        .mockResolvedValueOnce({ data: off(deactivated) } as never)
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
        .mockResolvedValueOnce({ data: off(tornDown) } as never)
        .mockResolvedValueOnce({ data: record("FAILED") } as never);
      mockedUpdate
        .mockResolvedValueOnce({ data: off(deactivated) } as never)
        .mockResolvedValueOnce({ data: record("DEPLOYING") } as never);

      await expect(SandboxInstance.reset("my-sandbox", { interval: 0 })).rejects.toThrow(/failed to deploy again/);
    });

    it("tolerates the record still reading off right after the switch-on write", async () => {
      mockedGet
        .mockResolvedValueOnce({ data: record("DEPLOYED") } as never)
        .mockResolvedValueOnce({ data: off(tornDown) } as never)
        .mockResolvedValueOnce({ data: off(tornDown) } as never)
        .mockResolvedValueOnce({ data: record("DEPLOYING") } as never)
        .mockResolvedValueOnce({ data: record("DEPLOYED") } as never);
      mockedUpdate
        .mockResolvedValueOnce({ data: off(deactivated) } as never)
        .mockResolvedValueOnce({ data: record("DEPLOYING") } as never);

      const instance = await SandboxInstance.reset("my-sandbox", { interval: 0 });

      expect(instance.status).toBe("DEPLOYED");
    });

    it("throws when the sandbox is taken down again once it is redeploying", async () => {
      mockedGet
        .mockResolvedValueOnce({ data: record("DEPLOYED") } as never)
        .mockResolvedValueOnce({ data: off(tornDown) } as never)
        .mockResolvedValueOnce({ data: record("DEPLOYING") } as never)
        .mockResolvedValueOnce({ data: off(tornDown) } as never);
      mockedUpdate
        .mockResolvedValueOnce({ data: off(deactivated) } as never)
        .mockResolvedValueOnce({ data: record("DEPLOYING") } as never);

      await expect(SandboxInstance.reset("my-sandbox", { interval: 0 })).rejects.toThrow(
        /is DEACTIVATED while it should be deployed again/,
      );
    });

    it("gives up after maxWait while it redeploys", async () => {
      mockedGet
        .mockResolvedValueOnce({ data: record("DEPLOYED") } as never)
        .mockResolvedValueOnce({ data: off(tornDown) } as never)
        .mockResolvedValue({ data: record("DEPLOYING") } as never);
      mockedUpdate
        .mockResolvedValueOnce({ data: off(deactivated) } as never)
        .mockResolvedValueOnce({ data: record("DEPLOYING") } as never);

      await expect(SandboxInstance.reset("my-sandbox", { interval: 5, maxWait: 40 })).rejects.toThrow(
        /is still DEPLOYING after waiting 0s/,
      );
    });

    it("waits until the sandbox answers, not only until it is DEPLOYED", async () => {
      mockedGet
        .mockResolvedValueOnce({ data: record("DEPLOYED") } as never)
        .mockResolvedValueOnce({ data: off(tornDown) } as never)
        .mockResolvedValue({ data: record("DEPLOYED") } as never);
      mockedUpdate
        .mockResolvedValueOnce({ data: off(deactivated) } as never)
        .mockResolvedValueOnce({ data: record("DEPLOYING") } as never);
      mockedHealth.mockResolvedValueOnce(notRoutable() as never).mockResolvedValueOnce(refused(503, "unavailable") as never);

      const instance = await SandboxInstance.reset("my-sandbox", { interval: 0 });

      expect(instance.status).toBe("DEPLOYED");
      expect(mockedHealth).toHaveBeenCalledTimes(3);
    });
  });
});
