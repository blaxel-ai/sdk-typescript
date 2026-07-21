import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeInterpreter, SandboxInstance } from "@blaxel/core";

const conflict = () => Object.assign(new Error("already exists"), { code: 409 });

const sandbox = (name: string, status: string) =>
  new SandboxInstance({
    metadata: { name },
    spec: {},
    status,
  } as any);

describe("SandboxInstance.createIfNotExists retry handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the server-side createIfNotExist parameter first", async () => {
    const existing = sandbox("existing", "DEPLOYED");
    const create = vi.spyOn(SandboxInstance, "create").mockResolvedValueOnce(existing);
    const get = vi.spyOn(SandboxInstance, "get");

    await expect(
      SandboxInstance.createIfNotExists({ name: "existing" }),
    ).resolves.toBe(existing);

    expect(create).toHaveBeenCalledWith(
      { name: "existing" },
      { createIfNotExist: true },
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("returns the existing reusable sandbox after a create conflict", async () => {
    const existing = sandbox("existing", "DEPLOYED");
    const create = vi.spyOn(SandboxInstance, "create").mockRejectedValueOnce(conflict());
    vi.spyOn(SandboxInstance, "get").mockResolvedValueOnce(existing);

    await expect(
      SandboxInstance.createIfNotExists({ name: "existing" }),
    ).resolves.toBe(existing);
    expect(create).toHaveBeenCalledWith(
      { name: "existing" },
      { createIfNotExist: true },
    );
  });

  it.each([
    "FAILED",
    "TERMINATED",
  ])("retries creation immediately when the conflicting sandbox is %s", async (status) => {
    const replacement = sandbox("stale", "DEPLOYED");
    const create = vi.spyOn(SandboxInstance, "create");
    create.mockRejectedValueOnce(conflict());
    create.mockResolvedValueOnce(replacement);
    const get = vi.spyOn(SandboxInstance, "get").mockResolvedValueOnce(sandbox("stale", status));

    await expect(
      SandboxInstance.createIfNotExists({ name: "stale" }),
    ).resolves.toBe(replacement);
    expect(create).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenNthCalledWith(
      1,
      { name: "stale" },
      { createIfNotExist: true },
    );
    expect(create).toHaveBeenNthCalledWith(
      2,
      { name: "stale" },
      { createIfNotExist: true },
    );
  });

  it.each([
    "TERMINATING",
    "DELETING",
    "DEACTIVATING",
  ])("waits out the dying record before retrying when the conflicting sandbox is %s", async (status) => {
    const replacement = sandbox("dying", "DEPLOYED");
    const create = vi.spyOn(SandboxInstance, "create");
    create.mockRejectedValueOnce(conflict());
    create.mockResolvedValueOnce(replacement);
    const get = vi.spyOn(SandboxInstance, "get")
      .mockResolvedValueOnce(sandbox("dying", status))
      .mockResolvedValue(sandbox("dying", "TERMINATED"));

    await expect(
      SandboxInstance.createIfNotExists({ name: "dying" }),
    ).resolves.toBe(replacement);
    expect(create).toHaveBeenCalledTimes(2);
    // initial status check plus at least one poll while the record was dying
    expect(get.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps polling while the record stays DELETING across several polls", async () => {
    const replacement = sandbox("slow-delete", "DEPLOYED");
    const create = vi.spyOn(SandboxInstance, "create");
    create.mockRejectedValueOnce(conflict());
    create.mockResolvedValueOnce(replacement);
    vi.spyOn(SandboxInstance, "get")
      .mockResolvedValueOnce(sandbox("slow-delete", "DELETING"))
      .mockResolvedValueOnce(sandbox("slow-delete", "DELETING"))
      .mockResolvedValueOnce(sandbox("slow-delete", "DELETING"))
      .mockResolvedValue(sandbox("slow-delete", "TERMINATED"));

    await expect(
      SandboxInstance.createIfNotExists({ name: "slow-delete" }),
    ).resolves.toBe(replacement);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("retries when the record vanishes between the create conflict and the status check", async () => {
    const replacement = sandbox("vanished", "DEPLOYED");
    const create = vi.spyOn(SandboxInstance, "create");
    create.mockRejectedValueOnce(conflict());
    create.mockResolvedValueOnce(replacement);
    vi.spyOn(SandboxInstance, "get").mockRejectedValue(
      Object.assign(new Error("Sandbox not found"), { code: 404 }),
    );

    await expect(
      SandboxInstance.createIfNotExists({ name: "vanished" }),
    ).resolves.toBe(replacement);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("waits out a persistent 'vanished' window instead of giving up after ~1s (ENG-3667)", async () => {
    vi.useFakeTimers();
    try {
      // An in-flight delete rejects creates (409) for 5s while the record is
      // already unreadable (get 404s). Pre-fix this threw 'vanished' after ~1s.
      const replacement = sandbox("vanished-slow", "DEPLOYED");
      const deleteFinishesAtMs = 5_000;
      const start = Date.now();
      const create = vi.spyOn(SandboxInstance, "create").mockImplementation(() => {
        if (Date.now() - start < deleteFinishesAtMs) return Promise.reject(conflict());
        return Promise.resolve(replacement);
      });
      vi.spyOn(SandboxInstance, "get").mockRejectedValue(
        Object.assign(new Error("Sandbox not found"), { code: 404 }),
      );

      const promise = SandboxInstance.createIfNotExists({ name: "vanished-slow" });
      const assertion = expect(promise).resolves.toBe(replacement);
      await vi.advanceTimersByTimeAsync(deleteFinishesAtMs + 1_000);
      await assertion;
      // It kept retrying through the window rather than stopping at 3 calls.
      expect(create.mock.calls.length).toBeGreaterThan(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a 'vanished' record after the bounded window plus the attempt budget", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(SandboxInstance, "create").mockRejectedValue(conflict());
      vi.spyOn(SandboxInstance, "get").mockRejectedValue(
        Object.assign(new Error("Sandbox not found"), { code: 404 }),
      );

      const promise = SandboxInstance.createIfNotExists({ name: "never-back" });
      const assertion = expect(promise).rejects.toThrow(
        "Unable to create sandbox after 3 attempts. Last conflicting status: vanished.",
      );
      // 30s transient window + the remaining attempts' 500ms waits
      await vi.advanceTimersByTimeAsync(32_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("converges when the 409 carries reason=CREATION_IN_PROGRESS (ENG-3776)", async () => {
    const winner = sandbox("locked", "DEPLOYED");
    const create = vi.spyOn(SandboxInstance, "create");
    create.mockRejectedValueOnce(
      Object.assign(new Error("being created"), {
        code: "SANDBOX_ALREADY_EXISTS",
        status_code: 409,
        reason: "CREATION_IN_PROGRESS",
      }),
    );
    // Row persisted while the lock is still held: get returns the winner.
    vi.spyOn(SandboxInstance, "get").mockResolvedValueOnce(winner);

    await expect(
      SandboxInstance.createIfNotExists({ name: "locked" }),
    ).resolves.toBe(winner);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("reports 'creation in progress' instead of 'vanished' when the lock 409 never resolves", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(SandboxInstance, "create").mockRejectedValue(
        Object.assign(new Error("being created"), {
          code: "SANDBOX_ALREADY_EXISTS",
          status_code: 409,
          reason: "CREATION_IN_PROGRESS",
        }),
      );
      vi.spyOn(SandboxInstance, "get").mockRejectedValue(
        Object.assign(new Error("Sandbox not found"), { code: 404 }),
      );

      const promise = SandboxInstance.createIfNotExists({ name: "locked-forever" });
      const assertion = expect(promise).rejects.toThrow(
        "Unable to create sandbox after 3 attempts. Last conflicting status: creation in progress.",
      );
      await vi.advanceTimersByTimeAsync(32_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates non-404 errors from the status check", async () => {
    vi.spyOn(SandboxInstance, "create").mockRejectedValueOnce(conflict());
    vi.spyOn(SandboxInstance, "get").mockRejectedValue(
      Object.assign(new Error("internal error"), { code: 500 }),
    );

    await expect(
      SandboxInstance.createIfNotExists({ name: "broken" }),
    ).rejects.toThrow("internal error");
  });

  it("retries promptly when the dying record disappears (get 404s) during the wait", async () => {
    const replacement = sandbox("gone", "DEPLOYED");
    const create = vi.spyOn(SandboxInstance, "create");
    create.mockRejectedValueOnce(conflict());
    create.mockResolvedValueOnce(replacement);
    vi.spyOn(SandboxInstance, "get")
      .mockResolvedValueOnce(sandbox("gone", "DELETING"))
      .mockRejectedValue(Object.assign(new Error("not found"), { code: 404 }));

    await expect(
      SandboxInstance.createIfNotExists({ name: "gone" }),
    ).resolves.toBe(replacement);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("gives up after the bounded wait when the record never settles", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(SandboxInstance, "create").mockRejectedValue(conflict());
      vi.spyOn(SandboxInstance, "get").mockResolvedValue(sandbox("stuck", "DELETING"));

      const promise = SandboxInstance.createIfNotExists({ name: "stuck" });
      const assertion = expect(promise).rejects.toThrow(
        "Unable to create sandbox after 3 attempts. Last conflicting status: DELETING.",
      );
      // two non-final attempts wait out the full 30s bound; the final attempt skips it
      await vi.advanceTimersByTimeAsync(61_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles a recreate race after first seeing a terminated sandbox", async () => {
    const winner = sandbox("race", "DEPLOYED");
    const create = vi.spyOn(SandboxInstance, "create");
    create.mockRejectedValueOnce(conflict());
    create.mockRejectedValueOnce(conflict());
    vi.spyOn(SandboxInstance, "get")
      .mockResolvedValueOnce(sandbox("race", "TERMINATED"))
      .mockResolvedValueOnce(winner);

    await expect(
      SandboxInstance.createIfNotExists({ name: "race" }),
    ).resolves.toBe(winner);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("stops after the bounded attempt budget when only stale sandboxes are seen", async () => {
    vi.spyOn(SandboxInstance, "create").mockRejectedValue(conflict());
    vi.spyOn(SandboxInstance, "get").mockResolvedValue(sandbox("stuck", "TERMINATED"));

    await expect(
      SandboxInstance.createIfNotExists({ name: "stuck" }),
    ).rejects.toThrow("Unable to create sandbox after 3 attempts.");
  });

  it("forwards createIfNotExist through CodeInterpreter.create", async () => {
    const create = vi.spyOn(SandboxInstance, "create").mockResolvedValueOnce(
      sandbox("interpreter", "DEPLOYED"),
    );

    await expect(
      CodeInterpreter.create(
        { name: "interpreter" },
        { safe: false, createIfNotExist: true },
      ),
    ).resolves.toBeInstanceOf(CodeInterpreter);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "interpreter" }),
      { safe: false, createIfNotExist: true },
    );
  });

  it("uses the server-side createIfNotExist parameter for CodeInterpreter.createIfNotExists", async () => {
    const create = vi.spyOn(SandboxInstance, "create").mockResolvedValueOnce(
      sandbox("interpreter-existing", "DEPLOYED"),
    );

    await expect(
      CodeInterpreter.createIfNotExists({ name: "interpreter-existing" }),
    ).resolves.toBeInstanceOf(CodeInterpreter);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "interpreter-existing" }),
      { safe: true, createIfNotExist: true },
    );
  });
});
