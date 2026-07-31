import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSandbox: vi.fn(),
  deleteSandbox: vi.fn(),
  getSandbox: vi.fn(),
  getSandboxByExternalId: vi.fn(),
  h2Get: vi.fn(),
  h2Warm: vi.fn(),
  listSandboxes: vi.fn(),
  updateSandbox: vi.fn(),
}));

vi.mock("../../@blaxel/core/src/client/index.js", () => ({
  ...mocks,
}));

vi.mock("../../@blaxel/core/src/common/h2pool.js", () => ({
  h2Pool: {
    get: mocks.h2Get,
    warm: mocks.h2Warm,
  },
}));

import { SandboxInstance } from "../../@blaxel/core/src/sandbox/sandbox.ts";

describe("SandboxInstance.create storage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("forwards storageMb to the sandbox runtime request body", async () => {
    mocks.h2Get.mockResolvedValue(null);
    mocks.createSandbox.mockResolvedValue({
      data: {
        metadata: { name: "storage" },
        spec: { region: "us-pdx-1", runtime: {} },
        status: "DEPLOYED",
      },
    });

    await SandboxInstance.create({
      name: "storage",
      image: "blaxel/base-image:latest",
      memory: 4096,
      region: "us-pdx-1",
      storageMb: 102400,
    });

    const [{ body }] = mocks.createSandbox.mock.calls[0];
    expect(body.spec.runtime.storageMb).toBe(102400);
  });

  it("omits storageMb from the runtime request body when unset", async () => {
    mocks.h2Get.mockResolvedValue(null);
    mocks.createSandbox.mockResolvedValue({
      data: {
        metadata: { name: "default-storage" },
        spec: { region: "us-pdx-1", runtime: {} },
        status: "DEPLOYED",
      },
    });

    await SandboxInstance.create({
      name: "default-storage",
      image: "blaxel/base-image:latest",
      memory: 4096,
      region: "us-pdx-1",
    });

    const [{ body }] = mocks.createSandbox.mock.calls[0];
    expect(Object.hasOwn(body.spec.runtime, "storageMb")).toBe(false);
  });
});
