import { afterEach, describe, expect, it, vi } from "vitest";
import { settings } from "../../common/settings.js";
import { MultipartInitiateResponse, MultipartPartInfo, MultipartUploadPartResponse, SuccessResponse } from "../client/index.js";
import { SandboxFileSystem } from "./filesystem.js";

type MultipartUploadHarness = {
  uploadWithMultipart: (path: string, blob: Blob, permissions?: string) => Promise<SuccessResponse>;
  initiateMultipartUpload: (path: string, permissions?: string) => Promise<MultipartInitiateResponse>;
  uploadPart: (uploadId: string, partNumber: number, fileBlob: Blob) => Promise<MultipartUploadPartResponse>;
  completeMultipartUpload: (uploadId: string, parts: Array<MultipartPartInfo>) => Promise<SuccessResponse>;
  abortMultipartUpload: (uploadId: string) => Promise<SuccessResponse>;
  sandbox?: { h2Domain?: string };
};

const waitForPartUpload = () => new Promise((resolve) => setTimeout(resolve, 5));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("SandboxFileSystem multipart upload", () => {
  afterEach(() => {
    delete settings.config.maxConcurrentUploadH2Requests;
    delete settings.config.fsPartRetries;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps an H2 upload slot busy across former batch boundaries for 100 MiB", async () => {
    settings.config.maxConcurrentUploadH2Requests = 2;
    const filesystem = Object.create(SandboxFileSystem.prototype) as MultipartUploadHarness;
    filesystem.sandbox = { h2Domain: "eng-3585.test" };
    const started = [deferred(), deferred(), deferred(), deferred()];
    const release = [deferred(), deferred(), deferred(), deferred()];
    let completedParts: Array<MultipartPartInfo> = [];

    filesystem.initiateMultipartUpload = () => Promise.resolve({ uploadId: "upload-1" });
    filesystem.uploadPart = async (_uploadId, partNumber) => {
      if (partNumber <= 4) {
        started[partNumber - 1].resolve();
        await release[partNumber - 1].promise;
      }
      return { partNumber, etag: `etag-${partNumber}` };
    };
    filesystem.completeMultipartUpload = (_uploadId, parts) => {
      completedParts = parts;
      return Promise.resolve({ message: "ok" });
    };
    filesystem.abortMultipartUpload = () => Promise.resolve({ message: "aborted" });

    const upload = filesystem.uploadWithMultipart(
      "/tmp/large-file.bin",
      { size: 100 * 1024 * 1024, slice: () => ({} as Blob) } as Blob,
    );

    await Promise.all([started[0].promise, started[1].promise]);
    release[0].resolve();
    await started[2].promise;
    release[2].resolve();

    const crossedBatchBoundary = await Promise.race([
      started[3].promise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);

    release[1].resolve();
    await started[3].promise;
    release[3].resolve();
    await upload;

    expect(crossedBatchBoundary).toBe(true);
    expect(completedParts).toHaveLength(20);
  });

  it("limits concurrent H2 part uploads to the existing cap", async () => {
    settings.config.maxConcurrentUploadH2Requests = 2;
    const filesystem = Object.create(SandboxFileSystem.prototype) as MultipartUploadHarness;
    filesystem.sandbox = { h2Domain: "concurrency.test" };
    let inFlight = 0;
    let maxInFlight = 0;
    const uploadedParts: number[] = [];
    let completedParts: Array<MultipartPartInfo> = [];

    filesystem.initiateMultipartUpload = () => Promise.resolve({ uploadId: "upload-1" });
    filesystem.uploadPart = async (_uploadId, partNumber) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await waitForPartUpload();
      uploadedParts.push(partNumber);
      inFlight -= 1;
      return { partNumber, etag: `etag-${partNumber}` };
    };
    filesystem.completeMultipartUpload = (_uploadId, parts) => {
      completedParts = parts;
      return Promise.resolve({ message: "ok" });
    };
    filesystem.abortMultipartUpload = () => Promise.resolve({ message: "aborted" });

    const blob = new Blob([new Uint8Array(16 * 1024 * 1024)]);

    await filesystem.uploadWithMultipart("/tmp/large-file.bin", blob);

    expect(maxInFlight).toBe(2);
    expect(uploadedParts.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(completedParts.map((part) => part.partNumber)).toEqual([1, 2, 3, 4]);
  });

  it("uploads every byte exactly once across chunk boundaries", async () => {
    const filesystem = Object.create(SandboxFileSystem.prototype) as MultipartUploadHarness;
    const partSize = 5 * 1024 * 1024;
    const source = new Uint8Array(partSize + 17);
    for (let index = 0; index < source.length; index++) {
      source[index] = index % 251;
    }
    const uploadedChunks = new Map<number, Uint8Array>();
    let completedParts: Array<MultipartPartInfo> = [];

    filesystem.initiateMultipartUpload = () => Promise.resolve({ uploadId: "upload-bytes" });
    filesystem.uploadPart = async (_uploadId, partNumber, fileBlob) => {
      uploadedChunks.set(partNumber, new Uint8Array(await fileBlob.arrayBuffer()));
      return { partNumber, etag: `etag-${partNumber}` };
    };
    filesystem.completeMultipartUpload = (_uploadId, parts) => {
      completedParts = parts;
      return Promise.resolve({ message: "ok" });
    };
    filesystem.abortMultipartUpload = () => Promise.resolve({ message: "aborted" });

    await filesystem.uploadWithMultipart("/tmp/bytes.bin", new Blob([source]));

    const received = new Uint8Array(source.length);
    let offset = 0;
    for (const partNumber of [1, 2]) {
      const chunk = uploadedChunks.get(partNumber);
      expect(chunk).toBeDefined();
      received.set(chunk!, offset);
      offset += chunk!.length;
    }
    let mismatch = -1;
    for (let index = 0; index < source.length; index++) {
      if (received[index] !== source[index]) {
        mismatch = index;
        break;
      }
    }

    expect([...uploadedChunks.values()].map((chunk) => chunk.length)).toEqual([partSize, 17]);
    expect(offset).toBe(source.length);
    expect(mismatch).toBe(-1);
    expect(completedParts.map((part) => part.partNumber)).toEqual([1, 2]);
  });

  it("retries a transient part failure without duplicating completed parts", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    settings.config.fsPartRetries = 1;
    const filesystem = Object.create(SandboxFileSystem.prototype) as MultipartUploadHarness;
    const attempts = new Map<number, number>();
    let completedParts: Array<MultipartPartInfo> = [];

    filesystem.initiateMultipartUpload = () => Promise.resolve({ uploadId: "upload-retry" });
    filesystem.uploadPart = (_uploadId, partNumber) => {
      const attempt = (attempts.get(partNumber) ?? 0) + 1;
      attempts.set(partNumber, attempt);
      if (partNumber === 1 && attempt === 1) {
        return Promise.reject(Object.assign(new Error("connection reset"), { code: "ECONNRESET" }));
      }
      return Promise.resolve({ partNumber, etag: `etag-${partNumber}` });
    };
    filesystem.completeMultipartUpload = (_uploadId, parts) => {
      completedParts = parts;
      return Promise.resolve({ message: "ok" });
    };
    filesystem.abortMultipartUpload = () => Promise.resolve({ message: "aborted" });

    const upload = filesystem.uploadWithMultipart(
      "/tmp/retry.bin",
      new Blob([new Uint8Array(6 * 1024 * 1024)]),
    );
    await vi.runAllTimersAsync();
    await upload;

    expect(Object.fromEntries(attempts)).toEqual({ 1: 2, 2: 1 });
    expect(completedParts.map((part) => part.partNumber)).toEqual([1, 2]);
  });

  it("stops assigning queued parts after a part failure", async () => {
    settings.config.maxConcurrentUploadH2Requests = 2;
    const filesystem = Object.create(SandboxFileSystem.prototype) as MultipartUploadHarness;
    filesystem.sandbox = { h2Domain: "cancellation.test" };
    const releaseFirstPart = deferred();
    const secondPartStarted = deferred();
    const failure = new Error("part 2 failed");
    const startedParts: number[] = [];
    const events: string[] = [];

    filesystem.initiateMultipartUpload = () => Promise.resolve({ uploadId: "upload-cancel" });
    filesystem.uploadPart = async (_uploadId, partNumber) => {
      startedParts.push(partNumber);
      if (partNumber === 1) {
        await releaseFirstPart.promise;
        events.push("part-1-finished");
        return { partNumber, etag: "etag-1" };
      }
      secondPartStarted.resolve();
      events.push("part-2-failed");
      throw failure;
    };
    filesystem.completeMultipartUpload = () => {
      throw new Error("completion must not run");
    };
    filesystem.abortMultipartUpload = () => {
      events.push("aborted");
      return Promise.resolve({ message: "aborted" });
    };

    const upload = filesystem.uploadWithMultipart(
      "/tmp/cancel.bin",
      new Blob([new Uint8Array(16 * 1024 * 1024)]),
    );
    await secondPartStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseFirstPart.resolve();

    await expect(upload).rejects.toBe(failure);
    expect(startedParts).toEqual([1, 2]);
    expect(events).toEqual(["part-2-failed", "part-1-finished", "aborted"]);
  });

  it("keeps sliced part data bounded by the active worker count", async () => {
    settings.config.maxConcurrentUploadH2Requests = 2;
    const filesystem = Object.create(SandboxFileSystem.prototype) as MultipartUploadHarness;
    filesystem.sandbox = { h2Domain: "memory.test" };
    let unsettledSlices = 0;
    let maxUnsettledSlices = 0;
    let totalSlices = 0;
    const fakeBlob = {
      size: 100 * 1024 * 1024,
      slice(start: number, end: number) {
        totalSlices += 1;
        unsettledSlices += 1;
        maxUnsettledSlices = Math.max(maxUnsettledSlices, unsettledSlices);
        return { size: end - start } as Blob;
      },
    } as Blob;

    filesystem.initiateMultipartUpload = () => Promise.resolve({ uploadId: "upload-memory" });
    filesystem.uploadPart = async (_uploadId, partNumber) => {
      await waitForPartUpload();
      unsettledSlices -= 1;
      return { partNumber, etag: `etag-${partNumber}` };
    };
    filesystem.completeMultipartUpload = () => Promise.resolve({ message: "ok" });
    filesystem.abortMultipartUpload = () => Promise.resolve({ message: "aborted" });

    await filesystem.uploadWithMultipart("/tmp/100mb.bin", fakeBlob);

    expect(totalSlices).toBe(20);
    expect(maxUnsettledSlices).toBe(2);
    expect(unsettledSlices).toBe(0);
  });

  it("aborts an abandoned multipart upload and preserves the part failure", async () => {
    settings.config.maxConcurrentUploadH2Requests = 1;
    const filesystem = Object.create(SandboxFileSystem.prototype) as MultipartUploadHarness;
    filesystem.sandbox = { h2Domain: "cleanup.test" };
    const partFailure = new Error("part failed");
    const abortFailure = new Error("abort failed");
    const aborts: string[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    filesystem.initiateMultipartUpload = () => Promise.resolve({ uploadId: "upload-cleanup" });
    filesystem.uploadPart = () => Promise.reject(partFailure);
    filesystem.completeMultipartUpload = () => {
      throw new Error("completion must not run");
    };
    filesystem.abortMultipartUpload = (uploadId) => {
      aborts.push(uploadId);
      return Promise.reject(abortFailure);
    };

    await expect(filesystem.uploadWithMultipart(
      "/tmp/cleanup.bin",
      new Blob([new Uint8Array(6 * 1024 * 1024)]),
    )).rejects.toBe(partFailure);

    expect(aborts).toEqual(["upload-cleanup"]);
    expect(consoleError).toHaveBeenCalledWith("Failed to abort multipart upload:", abortFailure);
  });
});
