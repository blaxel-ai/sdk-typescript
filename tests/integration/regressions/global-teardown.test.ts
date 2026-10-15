import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  sandboxes: vi.fn(), volumes: vi.fn(), deleteSandbox: vi.fn(), deleteVolume: vi.fn(),
}));
vi.mock("@blaxel/core", () => ({
  SandboxInstance: { list: api.sandboxes, delete: api.deleteSandbox },
  VolumeInstance: { list: api.volumes, delete: api.deleteVolume },
}));
import globalSetup from "../sandbox/globalTeardown.js";

beforeEach(() => {
  vi.stubEnv("BL_TEST_RUN_ID", "this-run");
  vi.stubEnv("SKIP_CLEANUP", "0");
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it("deletes only this run's resources, retaining Python, other TypeScript runs and unlabeled resources", async () => {
  const owned = { env: "integration-test", language: "typescript", "created-by": "vitest-integration", "test-run-id": "this-run" };
  const resources = [
    { name: "owned", labels: owned },
    { name: "other-ts", labels: { ...owned, "test-run-id": "other-run" } },
    { name: "python", labels: { ...owned, language: "python", "created-by": "pytest-integration" } },
    { name: "legacy", labels: { env: "integration-test", language: "typescript" } },
    { name: "unlabeled", labels: {} },
  ];
  api.sandboxes.mockResolvedValue({ autoPagingToArray: vi.fn().mockResolvedValue([
    ...resources.map(metadata => ({ metadata, status: "DEPLOYED" })),
    { metadata: { name: "terminated", labels: owned }, status: "TERMINATED" },
  ]) });
  api.volumes.mockResolvedValue({ autoPagingToArray: vi.fn().mockResolvedValue(resources.map(metadata => ({ name: metadata.name, metadata }))) });
  const teardown = globalSetup();
  // Teardown keeps the coordinator identity even if a test changes its environment.
  vi.stubEnv("BL_TEST_RUN_ID", "other-run");
  await teardown();
  expect(api.deleteSandbox.mock.calls).toEqual([["owned"]]);
  expect(api.deleteVolume.mock.calls).toEqual([["owned"]]);
});

it("does not list or delete anything without a run identity", async () => {
  vi.stubEnv("BL_TEST_RUN_ID", "");
  await globalSetup()();
  expect(api.sandboxes).not.toHaveBeenCalled();
  expect(api.volumes).not.toHaveBeenCalled();
  expect(api.deleteSandbox).not.toHaveBeenCalled();
  expect(api.deleteVolume).not.toHaveBeenCalled();
});
