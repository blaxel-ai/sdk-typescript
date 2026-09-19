import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the generated client so create() can be scripted and its request
// (body + query) inspected. sandbox.ts imports the same module, so vitest
// rewires both.
vi.mock("../../@blaxel/core/src/client/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../@blaxel/core/src/client/index.js")>();
  return { ...actual, createSandbox: vi.fn(), forkSnapshot: vi.fn() };
});

import { createSandbox, forkSnapshot } from "../../@blaxel/core/src/client/index.js";
import { CreateBatcher } from "../../@blaxel/core/src/sandbox/create-batcher.js";
import { SandboxInstance } from "../../@blaxel/core/src/sandbox/sandbox.js";
import { Snapshot } from "../../@blaxel/core/src/snapshot/index.js";

const mockedCreate = vi.mocked(createSandbox);
const mockedFork = vi.mocked(forkSnapshot);

type Call = { body: { metadata?: { name?: string }; spec?: { runtime?: { image?: string } } }; query?: { count?: number; createIfNotExist?: boolean } };

const record = (name: string) => ({ metadata: { name }, spec: { runtime: {} }, status: "DEPLOYED" });
const single = (name: string) => ({ data: record(name), response: { status: 200 } }) as never;
const many = (names: string[]) => ({ data: names.map(record), response: { status: 200 } }) as never;
const failure = (status: number, error: unknown) => ({ data: undefined, error, response: { status } }) as never;

const calls = () => mockedCreate.mock.calls.map((c) => c[0] as unknown as Call);

describe("SandboxInstance.create transparent batching", () => {
  beforeEach(() => {
    vi.stubEnv("BL_REGION", "");
    vi.stubEnv("BL_DISABLE_CREATE_BATCHING", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mockedCreate.mockReset();
    mockedFork.mockReset();
  });

  it("merges concurrent identical unnamed creates into one ?count=N request", async () => {
    mockedCreate.mockImplementation(async (opts) => {
      const { count } = (opts as unknown as Call).query ?? {};
      return many(Array.from({ length: count ?? 0 }, (_, i) => `srv-${i}`));
    });

    const instances = await Promise.all([
      SandboxInstance.create({ image: "custom:latest" }),
      SandboxInstance.create({ image: "custom:latest" }),
      SandboxInstance.create({ image: "custom:latest" }),
    ]);

    expect(calls()).toHaveLength(1);
    expect(calls()[0].query).toEqual({ count: 3 });
    expect(calls()[0].body.metadata?.name).toBeUndefined();
    expect(instances.map((i) => i.metadata.name)).toEqual(["srv-0", "srv-1", "srv-2"]);
  });

  it("sends a lone create as ?count=1 and still returns one instance", async () => {
    mockedCreate.mockResolvedValueOnce(many(["only"]));

    const instance = await SandboxInstance.create({ image: "custom:latest" });

    expect(calls()[0].query).toEqual({ count: 1 });
    expect(instance.metadata.name).toBe("only");
  });

  it("keeps different specs in different batches", async () => {
    mockedCreate.mockImplementation(async (opts) => {
      const call = opts as unknown as Call;
      const image = call.body.spec?.runtime?.image ?? "";
      return many(Array.from({ length: call.query?.count ?? 0 }, (_, i) => `${image}-${i}`));
    });

    const [a, b, c] = await Promise.all([
      SandboxInstance.create({ image: "a:latest" }),
      SandboxInstance.create({ image: "b:latest" }),
      SandboxInstance.create({ image: "a:latest" }),
    ]);

    expect(calls()).toHaveLength(2);
    expect(calls().map((c) => c.query?.count).sort()).toEqual([1, 2]);
    expect(a.metadata.name).toBe("a:latest-0");
    expect(c.metadata.name).toBe("a:latest-1");
    expect(b.metadata.name).toBe("b:latest-0");
  });

  it("never batches named creates, createIfNotExist, or batch: false", async () => {
    mockedCreate.mockResolvedValue(single("x"));

    await Promise.all([
      SandboxInstance.create({ name: "named", image: "custom:latest" }),
      SandboxInstance.create({ image: "custom:latest" }, { createIfNotExist: true }),
      SandboxInstance.create({ image: "custom:latest" }, { batch: false }),
    ]);

    expect(calls()).toHaveLength(3);
    for (const call of calls()) {
      expect(call.query?.count).toBeUndefined();
    }
    expect(calls()[1].query).toEqual({ createIfNotExist: true });
  });

  it("respects BL_DISABLE_CREATE_BATCHING", async () => {
    vi.stubEnv("BL_DISABLE_CREATE_BATCHING", "1");
    mockedCreate.mockResolvedValue(single("x"));

    await Promise.all([
      SandboxInstance.create({ image: "custom:latest" }),
      SandboxInstance.create({ image: "custom:latest" }),
    ]);

    expect(calls()).toHaveLength(2);
    expect(calls()[0].query).toBeUndefined();
  });

  it("rejects every merged caller with the same server error", async () => {
    const quota = { error: "QUOTA_EXCEEDED", message: "requested 2, limit 1" };
    mockedCreate.mockResolvedValueOnce(failure(429, quota));

    const results = await Promise.allSettled([
      SandboxInstance.create({ image: "custom:latest" }),
      SandboxInstance.create({ image: "custom:latest" }),
    ]);

    expect(calls()).toHaveLength(1);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    for (const r of results) {
      expect((r as PromiseRejectedResult).reason).toBe(quota);
    }
  });
});

describe("CreateBatcher", () => {
  it("flushes at the max size without waiting for the timer", async () => {
    const send = vi.fn(async (count: number) => Array.from({ length: count }, (_, i) => i));
    const batcher = new CreateBatcher<number>(() => 10_000, 3);

    const first = Promise.all([batcher.enqueue("k", send), batcher.enqueue("k", send), batcher.enqueue("k", send)]);
    expect(await first).toEqual([0, 1, 2]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(3);
    expect(batcher.size).toBe(0);
  });

  it("rejects the group when the server returns the wrong number of records", async () => {
    const batcher = new CreateBatcher<number>(() => 0);
    const results = await Promise.allSettled([
      batcher.enqueue("k", async () => [1]),
      batcher.enqueue("k", async () => [1]),
    ]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
  });
});

describe("SandboxInstance.createMany", () => {
  beforeEach(() => vi.stubEnv("BL_REGION", ""));
  afterEach(() => {
    vi.unstubAllEnvs();
    mockedCreate.mockReset();
  });

  it("sends one ?count=N request and returns N instances", async () => {
    mockedCreate.mockResolvedValueOnce(many(["a", "b", "c", "d"]));

    const instances = await SandboxInstance.createMany(4, { image: "custom:latest" });

    expect(calls()).toHaveLength(1);
    expect(calls()[0].query).toEqual({ count: 4 });
    expect(instances.map((i) => i.metadata.name)).toEqual(["a", "b", "c", "d"]);
  });

  it("refuses names and out-of-range counts before calling the API", async () => {
    await expect(SandboxInstance.createMany(2, { name: "x" })).rejects.toThrow(/generated names/);
    await expect(SandboxInstance.createMany(0)).rejects.toThrow(/between 1 and 100/);
    await expect(SandboxInstance.createMany(101)).rejects.toThrow(/between 1 and 100/);
    expect(calls()).toHaveLength(0);
  });

  it("throws the server error as-is", async () => {
    const quota = { error: "QUOTA_EXCEEDED" };
    mockedCreate.mockResolvedValueOnce(failure(429, quota));
    await expect(SandboxInstance.createMany(5, { image: "custom:latest" })).rejects.toBe(quota);
  });
});

describe("Snapshot.forkMany", () => {
  afterEach(() => mockedFork.mockReset());

  it("sends ?count=N without a targetName and returns N forks", async () => {
    mockedFork.mockResolvedValueOnce({ data: [{ name: "f1", type: "sandbox" }, { name: "f2", type: "sandbox" }] } as never);
    const snapshot = new Snapshot({ id: "snap-1", name: "snap" } as never);

    const forks = await snapshot.forkMany(2, { envs: [{ name: "A", value: "1" }] });

    const call = mockedFork.mock.calls[0][0] as unknown as { path: { snapshotName: string }; query?: { count?: number }; body: Record<string, unknown> };
    expect(call.path.snapshotName).toBe("snap-1");
    expect(call.query).toEqual({ count: 2 });
    expect(call.body.targetName).toBeUndefined();
    expect(call.body.targetType).toBe("sandbox");
    expect(forks.map((f) => f.name)).toEqual(["f1", "f2"]);
  });

  it("refuses out-of-range counts", async () => {
    const snapshot = new Snapshot({ id: "snap-1" } as never);
    await expect(snapshot.forkMany(0)).rejects.toThrow(/between 1 and 100/);
    expect(mockedFork).not.toHaveBeenCalled();
  });
});
