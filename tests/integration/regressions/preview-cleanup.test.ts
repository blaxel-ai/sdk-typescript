import { afterEach, beforeEach, expect, it, vi } from "vitest";

type TestSandbox = {
  metadata: { name: string; labels: Record<string, string> | undefined };
  status: string;
  previews: { list: () => Promise<{ name: string }[]>; delete: (name: string) => Promise<void> };
};
const api = vi.hoisted(() => ({
  get: vi.fn<(name?: string) => Promise<TestSandbox>>(),
  delete: vi.fn<(name: string) => Promise<void>>(),
  listPreviews: vi.fn<() => Promise<{ name: string }[]>>(),
  deletePreview: vi.fn<(name: string) => Promise<void>>(),
}));
vi.mock("@blaxel/core", () => ({ SandboxInstance: { get: api.get, delete: api.delete } }));
import { deleteTestSandbox } from "../sandbox/cleanup.js";

const labels = { env: "integration-test", language: "typescript", "created-by": "vitest-integration", "test-run-id": "this-run" };

beforeEach(() => {
  vi.stubEnv("SKIP_CLEANUP", "0");
  api.get.mockResolvedValue({
    metadata: { name: "owned", labels }, status: "DEPLOYED",
    previews: { list: api.listPreviews, delete: api.deletePreview },
  });
  api.listPreviews.mockResolvedValue([{ name: "one" }, { name: "two" }]);
  api.deletePreview.mockResolvedValue(undefined);
  api.delete.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

it("waits for all child previews to be deleted before deleting the parent", async () => {
  let finish!: () => void;
  api.deletePreview.mockImplementation((name: string) => name === "one" ? new Promise<void>(resolve => { finish = resolve; }) : Promise.resolve());
  const deleting = deleteTestSandbox("owned", "this-run");
  await vi.waitFor(() => expect(api.deletePreview).toHaveBeenCalledTimes(2));
  expect(api.delete).not.toHaveBeenCalled();
  finish();
  await deleting;
  expect(api.deletePreview.mock.calls).toEqual([["one"], ["two"]]);
  expect(api.delete).toHaveBeenCalledExactlyOnceWith("owned");
});

it("cleans previews from a terminated parent without deleting it again", async () => {
  const sandbox = await api.get();
  sandbox.status = "TERMINATED";
  await deleteTestSandbox("owned", "this-run");
  expect(api.deletePreview).toHaveBeenCalledTimes(2);
  expect(api.delete).not.toHaveBeenCalled();
});

it.each([
  { ...labels, "test-run-id": "another-run" },
  { ...labels, language: "python" },
  { ...labels, env: "benchmark" },
  { ...labels, "created-by": "someone-else" },
  {},
  undefined,
])("preserves a sandbox that does not belong to this run", async foreignLabels => {
  const sandbox = await api.get();
  sandbox.metadata.labels = foreignLabels;
  await deleteTestSandbox("owned", "this-run");
  expect(api.listPreviews).not.toHaveBeenCalled();
  expect(api.deletePreview).not.toHaveBeenCalled();
  expect(api.delete).not.toHaveBeenCalled();
});

it("does nothing without a run identity", async () => {
  await deleteTestSandbox("owned", "");
  expect(api.get).not.toHaveBeenCalled();
  expect(api.delete).not.toHaveBeenCalled();
});

it("honors SKIP_CLEANUP before looking up resources", async () => {
  vi.stubEnv("SKIP_CLEANUP", "1");
  await deleteTestSandbox("owned", "this-run");
  expect(api.get).not.toHaveBeenCalled();
  expect(api.delete).not.toHaveBeenCalled();
});

it("still deletes the parent and other previews when one preview deletion fails", async () => {
  const failure = new Error("preview delete failed");
  api.deletePreview.mockRejectedValueOnce(failure);
  const error = await deleteTestSandbox("owned", "this-run").catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toEqual([failure]);
  expect(api.deletePreview.mock.calls).toEqual([["one"], ["two"]]);
  expect(api.delete).toHaveBeenCalledExactlyOnceWith("owned");
});

it("still deletes the parent when listing its previews fails", async () => {
  const failure = new Error("preview listing failed");
  api.listPreviews.mockRejectedValue(failure);
  const error = await deleteTestSandbox("owned", "this-run").catch((error: unknown) => error);
  expect((error as AggregateError).errors).toEqual([failure]);
  expect(api.delete).toHaveBeenCalledExactlyOnceWith("owned");
});

it("reports parent deletion failures after removing previews", async () => {
  const failure = new Error("sandbox delete failed");
  api.delete.mockRejectedValue(failure);
  const error = await deleteTestSandbox("owned", "this-run").catch((error: unknown) => error);
  expect((error as AggregateError).errors).toEqual([failure]);
  expect(api.deletePreview).toHaveBeenCalledTimes(2);
});

it("does not delete when ownership lookup fails", async () => {
  const failure = new Error("sandbox lookup failed");
  api.get.mockRejectedValue(failure);
  await expect(deleteTestSandbox("owned", "this-run")).rejects.toBe(failure);
  expect(api.listPreviews).not.toHaveBeenCalled();
  expect(api.delete).not.toHaveBeenCalled();
});

it("keeps the fixture's captured run identity if a test changes the environment", async () => {
  vi.stubEnv("BL_TEST_RUN_ID", "this-run");
  vi.resetModules();
  const fixture = await import("../sandbox/cleanup.js");
  vi.stubEnv("BL_TEST_RUN_ID", "another-run");
  await fixture.deleteTestSandbox("owned");
  expect(api.delete).toHaveBeenCalledExactlyOnceWith("owned");
});
