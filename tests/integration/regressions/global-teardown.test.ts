import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  sandboxes: vi.fn(), volumes: vi.fn(), deleteSandbox: vi.fn(), deleteVolume: vi.fn(), getSandbox: vi.fn(), deletePreview: vi.fn<(...names: string[]) => Promise<void>>(),
}));
vi.mock("@blaxel/core", () => ({
  SandboxInstance: { list: api.sandboxes, delete: api.deleteSandbox, get: api.getSandbox },
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
  api.getSandbox.mockImplementation((name: string) => Promise.resolve({
    metadata: { name, labels: owned }, status: name === "terminated" ? "TERMINATED" : "DEPLOYED",
    previews: {
      list: () => Promise.resolve([{ name: "preview-" + name }]),
      delete: (preview: string) => api.deletePreview(name, preview),
    },
  }));
  const teardown = globalSetup();
  // Teardown keeps the coordinator identity even if a test changes its environment.
  vi.stubEnv("BL_TEST_RUN_ID", "other-run");
  await teardown();
  expect(api.sandboxes).toHaveBeenCalledExactlyOnceWith({ showTerminated: true });
  expect(api.getSandbox.mock.calls).toEqual([["owned"], ["terminated"]]);
  expect(api.deletePreview.mock.calls).toEqual([["owned", "preview-owned"], ["terminated", "preview-terminated"]]);
  expect(api.deletePreview.mock.invocationCallOrder[0]).toBeLessThan(api.deleteSandbox.mock.invocationCallOrder[0]);
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


it("continues cleaning owned resources after a preview deletion fails", async () => {
  const labels = { env: "integration-test", language: "typescript", "created-by": "vitest-integration", "test-run-id": "this-run" };
  api.sandboxes.mockResolvedValue({ autoPagingToArray: vi.fn().mockResolvedValue([
    { metadata: { name: "first", labels }, status: "DEPLOYED" },
    { metadata: { name: "second", labels }, status: "DEPLOYED" },
  ]) });
  api.getSandbox.mockImplementation((name: string) => Promise.resolve({
    metadata: { name, labels }, status: "DEPLOYED",
    previews: { list: () => Promise.resolve([{ name: "preview" }]), delete: () => api.deletePreview(name) },
  }));
  const failure = new Error("preview delete failed");
  api.deletePreview.mockRejectedValueOnce(failure);
  api.volumes.mockResolvedValue({ autoPagingToArray: vi.fn().mockResolvedValue([{ name: "volume", metadata: { labels } }]) });
  await globalSetup()();
  expect(api.deletePreview.mock.calls).toEqual([["first"], ["second"]]);
  expect(api.deleteSandbox.mock.calls).toEqual([["first"], ["second"]]);
  expect(api.deleteVolume).toHaveBeenCalledExactlyOnceWith("volume");
  const reported = vi.mocked(console.log).mock.calls.find(call => call[0] === "  Error cleaning sandbox first:");
  expect(reported?.[1]).toBeInstanceOf(AggregateError);
  expect((reported?.[1] as AggregateError).errors).toEqual([failure]);
});

it("honors SKIP_CLEANUP before listing resources", async () => {
  vi.stubEnv("SKIP_CLEANUP", "1");
  await globalSetup()();
  expect(api.sandboxes).not.toHaveBeenCalled();
  expect(api.volumes).not.toHaveBeenCalled();
});
