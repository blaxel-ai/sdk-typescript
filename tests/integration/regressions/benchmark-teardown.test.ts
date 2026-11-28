import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ list: vi.fn(), delete: vi.fn() }));
vi.mock("@blaxel/core", () => ({
  SandboxInstance: { list: api.list, delete: api.delete },
}));
import globalSetup from "../../benchmarks/sandbox/teardown.js";

const ownedLabels = {
  env: "benchmark",
  language: "typescript",
  "created-by": "vitest-bench",
  "test-run-id": "this-run",
};

function listSandboxes(metadata: { name?: string, labels?: Record<string, string> }[]) {
  const page = vi.fn().mockResolvedValue(metadata.map(metadata => ({ metadata })));
  api.list.mockResolvedValue({ autoPagingToArray: page });
  return page;
}

beforeEach(() => {
  vi.stubEnv("BL_TEST_RUN_ID", "this-run");
  vi.stubEnv("SKIP_CLEANUP", "0");
  api.delete.mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it("deletes only this run's benchmark sandboxes", async () => {
  const page = listSandboxes([
    { name: "owned", labels: ownedLabels },
    { name: "other-run", labels: { ...ownedLabels, "test-run-id": "other-run" } },
    { name: "legacy", labels: { env: "benchmark", language: "typescript" } },
    { name: "other-creator", labels: { ...ownedLabels, "created-by": "other-tool" } },
    { name: "python", labels: { ...ownedLabels, language: "python" } },
    { name: "integration", labels: { ...ownedLabels, env: "integration-test" } },
    { name: "unlabeled" },
  ]);

  await globalSetup()();

  expect(page).toHaveBeenCalledWith({ limit: 10000 });
  expect(api.delete.mock.calls).toEqual([["owned"]]);
});

it("keeps the setup identity even if a test changes its environment", async () => {
  listSandboxes([
    { name: "owned", labels: ownedLabels },
    { name: "other-run", labels: { ...ownedLabels, "test-run-id": "other-run" } },
  ]);
  const teardown = globalSetup();
  vi.stubEnv("BL_TEST_RUN_ID", "other-run");

  await teardown();

  expect(api.delete.mock.calls).toEqual([["owned"]]);
});

it.each([undefined, ""])("does not list or delete without a run identity (%s)", async runId => {
  vi.stubEnv("BL_TEST_RUN_ID", runId);

  await globalSetup()();

  expect(api.list).not.toHaveBeenCalled();
  expect(api.delete).not.toHaveBeenCalled();
});

it("honors SKIP_CLEANUP without listing resources", async () => {
  vi.stubEnv("SKIP_CLEANUP", "1");

  await globalSetup()();

  expect(api.list).not.toHaveBeenCalled();
  expect(api.delete).not.toHaveBeenCalled();
});

it("continues deleting owned sandboxes after an individual failure", async () => {
  listSandboxes([
    { name: "failed", labels: ownedLabels },
    { name: "owned", labels: ownedLabels },
  ]);
  api.delete.mockRejectedValueOnce(new Error("delete failed"));

  await globalSetup()();

  expect(api.delete.mock.calls).toEqual([["failed"], ["owned"]]);
});

it("does not delete resources when listing fails", async () => {
  api.list.mockRejectedValue(new Error("list failed"));

  await expect(globalSetup()()).resolves.toBeUndefined();

  expect(api.delete).not.toHaveBeenCalled();
});

it("does not delete an owned resource without a name", async () => {
  listSandboxes([{ labels: ownedLabels }]);

  await globalSetup()();

  expect(api.delete).not.toHaveBeenCalled();
});

it("labels benchmark fixtures with the same identity captured by teardown", async () => {
  vi.resetModules();
  const { defaultLabels } = await import("../../benchmarks/sandbox/helpers.js");
  expect(defaultLabels).toEqual(ownedLabels);
  listSandboxes([{ name: "fixture", labels: defaultLabels }]);
  const teardown = globalSetup();
  vi.stubEnv("BL_TEST_RUN_ID", "other-run");

  await teardown();

  expect(api.delete.mock.calls).toEqual([["fixture"]]);
});
