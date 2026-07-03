// Reproducers: transient createIfNotExists failures.
//
// These tests intentionally PASS -- they prove two production failure modes of
// SandboxInstance.createIfNotExists (sandbox.ts:384-435) exist today. They are
// NOT asserting correct behaviour; a fix would flip their expectations.
//
//   Issue A ('vanished', ~237 failures/day): on a 409 create conflict the status
//     check get() returns 404 because the control plane still holds the create-
//     uniqueness lock but has not yet persisted the DB row. createIfNotExists
//     labels this 'vanished' and only retries 3x with 500ms waits (~1s of actual
//     waiting inside a ~1.5s budget) before throwing. The 'dying' path, driven by
//     the SAME underlying cause (a conflict that resolves on its own), instead
//     waits up to 30s via waitWhileSandboxDying -- 20x more patient.
//
//   Issue B (GOAWAY, ~26 failures/day): a GOAWAY thrown by the HTTP/2 transport
//     (h2fetch.ts:465-467) is classified transient (isTransientResetError ===
//     true) and IS retried on data-plane reads via retryOnTransientReset -- but
//     createIfNotExists never wraps create() in retryOnTransientReset, so a
//     GOAWAY during create is rethrown immediately with no retry.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxInstance } from "../../../@blaxel/core/src/sandbox/sandbox.js";
import { isTransientResetError } from "../../../@blaxel/core/src/common/transient-retry.js";

const conflict = () => Object.assign(new Error("already exists"), { code: 409 });
const notFound = () => Object.assign(new Error("Sandbox not found"), { code: 404 });
// Mirrors the message h2fetch.ts:466 rejects an in-flight request with when the
// peer sends GOAWAY before responding.
const goaway = () => new Error("HTTP/2 session sent GOAWAY before response");

const sandbox = (name: string, status: string) =>
  new SandboxInstance({
    metadata: { name },
    spec: {},
    status,
  } as never);

describe("createIfNotExists transient failure reproducers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("Issue A: 'vanished' is abandoned after ~1.5s while 'dying' waits up to 30s", () => {
    it("throws 'vanished' after ~1s even though the row would appear seconds later", async () => {
      vi.useFakeTimers();

      // The control plane holds the create-uniqueness lock (create -> 409) and
      // has not yet written the DB row (get -> 404) for the whole creation
      // window. Here that window lasts 5s; the row would appear at t=5s.
      const rowWrittenAtMs = 5_000;
      const start = Date.now();

      const create = vi.spyOn(SandboxInstance, "create").mockImplementation(() => {
        if (Date.now() - start < rowWrittenAtMs) return Promise.reject(conflict());
        return Promise.resolve(sandbox("vanished", "DEPLOYED"));
      });
      const get = vi.spyOn(SandboxInstance, "get").mockImplementation(() => {
        if (Date.now() - start < rowWrittenAtMs) return Promise.reject(notFound());
        return Promise.resolve(sandbox("vanished", "DEPLOYED"));
      });

      let settledAtMs = -1;
      const promise = SandboxInstance.createIfNotExists({ name: "vanished" }).catch((e) => {
        settledAtMs = Date.now() - start;
        throw e;
      });
      const assertion = expect(promise).rejects.toThrow(
        "Unable to create sandbox after 3 attempts. Last conflicting status: vanished.",
      );

      // Drive virtual time well past the moment the row would have been written.
      await vi.advanceTimersByTimeAsync(rowWrittenAtMs + 2_000);
      await assertion;

      // Gave up after only the ~1s of 500ms waits (2 non-final attempts), even
      // though waiting a few more seconds would have found the freshly-written
      // record. This is the 237-failures/day 'vanished' bug.
      expect(settledAtMs).toBeGreaterThan(0);
      expect(settledAtMs).toBeLessThan(2_000);
      expect(create).toHaveBeenCalledTimes(3);
      expect(get).toHaveBeenCalledTimes(3);
    });

    it("waits many seconds (up to 30s) when the same cause surfaces as a 'dying' record", async () => {
      vi.useFakeTimers();

      // Same underlying cause -- a create conflict that resolves on its own --
      // but here the status check sees a TERMINATING record instead of a 404.
      // That routes through waitWhileSandboxDying, which polls up to 30s.
      const settlesAtMs = 10_000;
      const start = Date.now();
      const replacement = sandbox("dying", "DEPLOYED");

      const create = vi.spyOn(SandboxInstance, "create");
      create.mockRejectedValueOnce(conflict());
      create.mockResolvedValueOnce(replacement);
      vi.spyOn(SandboxInstance, "get").mockImplementation(() => {
        if (Date.now() - start < settlesAtMs) return Promise.resolve(sandbox("dying", "TERMINATING"));
        return Promise.resolve(sandbox("dying", "TERMINATED"));
      });

      let resolvedAtMs = -1;
      const promise = SandboxInstance.createIfNotExists({ name: "dying" }).then((v) => {
        resolvedAtMs = Date.now() - start;
        return v;
      });

      await vi.advanceTimersByTimeAsync(settlesAtMs + 1_000);
      await expect(promise).resolves.toBe(replacement);

      // The 'dying' path patiently waited ~10s (and would tolerate up to 30s)
      // before retrying -- 20x the ~1s budget the identical-cause 'vanished'
      // path is given above.
      expect(resolvedAtMs).toBeGreaterThanOrEqual(10_000);
      expect(create).toHaveBeenCalledTimes(2);
    });

    it("caps the 'dying' wait at ~30s per non-final attempt (~61s to exhaust the budget)", async () => {
      vi.useFakeTimers();

      // A record that never settles proves the 30s ceiling: two non-final
      // attempts each burn the full 30s bound, so it takes ~60s to give up --
      // vs ~1s for 'vanished'.
      vi.spyOn(SandboxInstance, "create").mockRejectedValue(conflict());
      vi.spyOn(SandboxInstance, "get").mockResolvedValue(sandbox("stuck", "DELETING"));

      const promise = SandboxInstance.createIfNotExists({ name: "stuck" });
      const assertion = expect(promise).rejects.toThrow(
        "Unable to create sandbox after 3 attempts. Last conflicting status: DELETING.",
      );
      await vi.advanceTimersByTimeAsync(61_000);
      await assertion;
    });
  });

  describe("Issue B: GOAWAY is transient but createIfNotExists never retries create()", () => {
    it("classifies a GOAWAY error as transient (isTransientResetError === true)", () => {
      // The exact message h2fetch.ts rejects with, plus the node error-code form.
      expect(isTransientResetError(goaway())).toBe(true);
      expect(
        isTransientResetError(
          Object.assign(new Error("stream reset"), { code: "ERR_HTTP2_GOAWAY_SESSION" }),
        ),
      ).toBe(true);
    });

    it("does NOT retry create() on a GOAWAY -- it is rethrown immediately", async () => {
      const err = goaway();
      // The error is transient, yet only the 409 branch retries, so it must be
      // classified transient AND still bubble straight out of createIfNotExists.
      expect(isTransientResetError(err)).toBe(true);

      const create = vi.spyOn(SandboxInstance, "create").mockRejectedValue(err);
      const get = vi.spyOn(SandboxInstance, "get");

      await expect(
        SandboxInstance.createIfNotExists({ name: "goaway" }),
      ).rejects.toThrow("HTTP/2 session sent GOAWAY before response");

      // No retry: create() ran exactly once and the status-check path was never
      // reached. createIfNotExists does not wrap create() in retryOnTransientReset.
      expect(create).toHaveBeenCalledTimes(1);
      expect(get).not.toHaveBeenCalled();
    });
  });
});
