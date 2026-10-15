import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the generated client so create() can be scripted and its request body
// inspected. sandbox.ts imports the same module, so vitest rewires both.
vi.mock("../../@blaxel/core/src/client/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../@blaxel/core/src/client/index.js")>();
  return { ...actual, createSandbox: vi.fn() };
});

import { createSandbox } from "../../@blaxel/core/src/client/index.js";
import { SandboxInstance } from "../../@blaxel/core/src/sandbox/sandbox.js";

const mockedCreate = vi.mocked(createSandbox);

// The server names the sandbox and returns the record; create() must surface
// that name on the instance.
const created = (name: string) =>
  ({ data: { metadata: { name }, spec: { runtime: {} }, status: "DEPLOYED" }, response: { status: 200 } }) as never;

const sentBody = () => (mockedCreate.mock.calls[0][0] as { body: { metadata?: { name?: string } } }).body;

describe("SandboxInstance.create name handling (ENG-3931)", () => {
  beforeEach(() => {
    // Keep edgeDomain null so create() skips the real H2 warm-up path.
    vi.stubEnv("BL_REGION", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mockedCreate.mockReset();
  });

  it("omits metadata.name when no name is provided so the server assigns one", async () => {
    mockedCreate.mockResolvedValueOnce(created("srv-assigned"));

    const instance = await SandboxInstance.create({ image: "custom:latest" });

    expect(sentBody().metadata?.name).toBeUndefined();
    expect(instance.metadata.name).toBe("srv-assigned");
  });

  it("omits metadata.name for a raw model without a name", async () => {
    mockedCreate.mockResolvedValueOnce(created("srv-assigned"));

    await SandboxInstance.create({ spec: { runtime: { image: "custom:latest" } } } as never);

    expect(sentBody().metadata?.name).toBeUndefined();
  });

  it("keeps the caller-provided name", async () => {
    mockedCreate.mockResolvedValueOnce(created("mysbx"));

    const instance = await SandboxInstance.create({ name: "mysbx", image: "custom:latest" });

    expect(sentBody().metadata?.name).toBe("mysbx");
    expect(instance.metadata.name).toBe("mysbx");
  });
});
