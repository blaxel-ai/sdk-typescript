import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeInterpreter, SandboxInstance } from "@blaxel/core";
import type { SandboxConfiguration } from "@blaxel/core";

const conflict = () =>
  Object.assign(new Error("already exists"), { code: "SANDBOX_ALREADY_EXISTS", status_code: 409 });

const sandbox = (name: string, status: string) =>
  new SandboxInstance({
    metadata: { name },
    spec: {},
    status,
  } as unknown as SandboxConfiguration);

describe("SandboxInstance.createIfNotExists", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates to a single create with the server-side createIfNotExist parameter", async () => {
    const existing = sandbox("existing", "DEPLOYED");
    const create = vi.spyOn(SandboxInstance, "create").mockResolvedValueOnce(existing);
    const get = vi.spyOn(SandboxInstance, "get");

    await expect(
      SandboxInstance.createIfNotExists({ name: "existing" }),
    ).resolves.toBe(existing);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      { name: "existing" },
      { createIfNotExist: true },
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("surfaces a 409 from the control plane as is instead of polling and retrying", async () => {
    const create = vi.spyOn(SandboxInstance, "create").mockRejectedValue(conflict());
    const get = vi.spyOn(SandboxInstance, "get");

    await expect(
      SandboxInstance.createIfNotExists({ name: "taken" }),
    ).rejects.toMatchObject({ code: "SANDBOX_ALREADY_EXISTS", status_code: 409 });

    expect(create).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
  });

  it("propagates other create errors", async () => {
    vi.spyOn(SandboxInstance, "create").mockRejectedValueOnce(
      Object.assign(new Error("internal error"), { code: 500 }),
    );

    await expect(
      SandboxInstance.createIfNotExists({ name: "broken" }),
    ).rejects.toThrow("internal error");
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
