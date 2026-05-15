import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxInstance } from "@blaxel/core";

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

  it("returns the existing reusable sandbox after a create conflict", async () => {
    const existing = sandbox("existing", "DEPLOYED");
    vi.spyOn(SandboxInstance, "create").mockRejectedValueOnce(conflict());
    vi.spyOn(SandboxInstance, "get").mockResolvedValueOnce(existing);

    await expect(
      SandboxInstance.createIfNotExists({ name: "existing" }),
    ).resolves.toBe(existing);
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
});
