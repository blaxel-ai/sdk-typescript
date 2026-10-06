import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../@blaxel/core/src/client/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../@blaxel/core/src/client/index.js")>();
  return { ...actual, createSandbox: vi.fn(), getSandbox: vi.fn() };
});

import { createSandbox } from "../../@blaxel/core/src/client/index.js";
import { describeDrift } from "../../@blaxel/core/src/sandbox/drift.js";
import { SandboxInstance } from "../../@blaxel/core/src/sandbox/sandbox.js";

const mockedCreate = vi.mocked(createSandbox);

// The record the control plane returns. GET and createIfNotExist both mask every env value.
const record = (runtime: Record<string, unknown> = {}, region = "us-was-1") =>
  ({
    data: { metadata: { name: "sbx" }, spec: { region, runtime }, status: "DEPLOYED" },
    response: { status: 200 },
    request: {},
  }) as never;

const existing = () =>
  record({
    image: "sandbox/app:v1",
    memory: 2048,
    envs: [{ name: "KEEP", value: "****" }, { name: "TOKEN", value: "****", secret: true }],
  });

describe("SandboxInstance.createIfNotExists drift warning", () => {
  let warnings: string[];
  const driftWarnings = () => warnings.filter((message) => message.includes("already exists"));

  beforeEach(() => {
    vi.stubEnv("BL_REGION", "");
    warnings = [];
    vi.spyOn(console, "warn").mockImplementation((message?: unknown) => {
      warnings.push(String(message));
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    mockedCreate.mockReset();
  });

  it("warns once, naming every field that differs, and still returns the existing sandbox", async () => {
    mockedCreate.mockResolvedValueOnce(existing());

    const instance = await SandboxInstance.createIfNotExists({
      name: "sbx",
      image: "sandbox/app:v2",
      memory: 8192,
      region: "us-pdx-1",
      envs: [{ name: "KEEP", value: "same" }, { name: "ADDED", value: "x" }],
    });

    const [message, ...rest] = driftWarnings();
    expect(rest).toEqual([]);
    expect(message).toContain('sandbox "sbx" already exists');
    expect(message).toContain("image (requested sandbox/app:v2, existing sandbox/app:v1)");
    expect(message).toContain("memory (requested 8192 MB, existing 2048 MB)");
    expect(message).toContain("region (requested us-pdx-1, existing us-was-1)");
    expect(message).toContain("envs (not set on the existing sandbox: ADDED)");
    expect(message).toContain("Delete the sandbox and create it again");
    // Nothing about the call changed: one request, the existing record handed back as is.
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(instance.spec.runtime?.image).toBe("sandbox/app:v1");
    expect(instance.spec.runtime?.memory).toBe(2048);
  });

  it("stays quiet when the sandbox matches the request, as a new sandbox does", async () => {
    mockedCreate.mockResolvedValueOnce(existing());
    await SandboxInstance.createIfNotExists({
      name: "sbx",
      image: "sandbox/app:v1",
      memory: 2048,
      region: "us-was-1",
      envs: [{ name: "KEEP", value: "anything" }],
    });
    expect(driftWarnings()).toEqual([]);
  });

  it("compares only what the caller set, never the SDK defaults", async () => {
    mockedCreate.mockResolvedValueOnce(existing());
    // No image and no memory: the SDK sends base-image and 4096 MB, which the caller never asked for.
    await SandboxInstance.createIfNotExists({ name: "sbx" });
    expect(driftWarnings()).toEqual([]);
  });

  it("treats an untagged image as :latest", async () => {
    mockedCreate.mockResolvedValueOnce(record({ image: "blaxel/base-image:latest" }));
    await SandboxInstance.createIfNotExists({ name: "sbx", image: "blaxel/base-image" });
    mockedCreate.mockResolvedValueOnce(record({ image: "blaxel/base-image" }));
    await SandboxInstance.createIfNotExists({ name: "sbx", image: "blaxel/base-image:latest" });
    expect(driftWarnings()).toEqual([]);
  });

  it("reads the model form of the request too", async () => {
    mockedCreate.mockResolvedValueOnce(existing());
    await SandboxInstance.createIfNotExists({
      metadata: { name: "sbx" },
      spec: { region: "us-was-1", runtime: { image: "sandbox/app:v3", memory: 2048 } },
    });
    const [message] = driftWarnings();
    expect(message).toContain("image (requested sandbox/app:v3, existing sandbox/app:v1)");
    expect(message).not.toContain("memory");
    expect(message).not.toContain("region");
  });

  it("does not warn for a plain create", async () => {
    mockedCreate.mockResolvedValueOnce(existing());
    await SandboxInstance.create({ name: "sbx", image: "sandbox/app:v2", memory: 8192, region: "us-was-1" });
    expect(driftWarnings()).toEqual([]);
  });

  it("does not warn about a field the existing sandbox did not report", async () => {
    mockedCreate.mockResolvedValueOnce(record({}, ""));
    await SandboxInstance.createIfNotExists({ name: "sbx", image: "sandbox/app:v2", memory: 8192, region: "us-pdx-1", envs: [{ name: "A", value: "1" }] });
    expect(driftWarnings()).toEqual([]);
  });

  it("never lets the comparison fail the create", async () => {
    // envs is not an array: the comparison throws, the create must not.
    mockedCreate.mockResolvedValueOnce(record({ image: "sandbox/app:v1", envs: "oops" }));
    await expect(
      SandboxInstance.createIfNotExists({ name: "sbx", image: "sandbox/app:v2", envs: [{ name: "A", value: "1" }] }),
    ).resolves.toBeInstanceOf(SandboxInstance);
  });
});

describe("describeDrift", () => {
  it("reports env names, never env values", () => {
    const drift = describeDrift(
      { envs: [{ name: "API_KEY", value: "super-secret" }, { name: "MODE", value: "new" }] },
      { spec: { runtime: { envs: [{ name: "MODE", value: "old" }] } } },
    );
    expect(drift).toEqual(["envs (not set on the existing sandbox: API_KEY; different value: MODE)"]);
    expect(drift.join()).not.toMatch(/super-secret|new|old/);
  });

  it("cannot see a changed env value while the control plane masks it", () => {
    expect(describeDrift({ envs: [{ name: "MODE", value: "new" }] }, { spec: { runtime: { envs: [{ name: "MODE", value: "****" }] } } })).toEqual([]);
  });

  it("normalizes image references before comparing", () => {
    const same = (requested: string, existingImage: string) =>
      describeDrift({ image: requested }, { spec: { runtime: { image: existingImage } } });
    expect(same("app", "app:latest")).toEqual([]);
    expect(same("registry.io:5000/app", "registry.io:5000/app:latest")).toEqual([]);
    expect(same("app@sha256:abc", "app@sha256:abc")).toEqual([]);
    expect(same("app:v2", "app:v1")).toHaveLength(1);
    expect(same("registry.io:5000/app:v2", "registry.io:5000/app:v1")).toHaveLength(1);
  });
});
