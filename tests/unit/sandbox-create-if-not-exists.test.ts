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
    "TERMINATING",
    "DELETING",
    "DEACTIVATING",
  ])("retries creation when the conflicting sandbox is %s", async (status) => {
    const replacement = sandbox("stale", "DEPLOYED");
    const create = vi.spyOn(SandboxInstance, "create");
    create.mockRejectedValueOnce(conflict());
    create.mockResolvedValueOnce(replacement);
    vi.spyOn(SandboxInstance, "get").mockResolvedValueOnce(sandbox("stale", status));

    await expect(
      SandboxInstance.createIfNotExists({ name: "stale" }),
    ).resolves.toBe(replacement);
    expect(create).toHaveBeenCalledTimes(2);
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
