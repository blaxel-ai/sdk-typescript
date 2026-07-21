import { describe, expect, it } from "vitest";
import type {
  MultipartInitiateResponse,
  MultipartPartInfo,
  MultipartUploadPartResponse,
  SuccessResponse,
} from "../../@blaxel/core/src/sandbox/client/index.js";
import { SandboxFileSystem } from "../../@blaxel/core/src/sandbox/filesystem/filesystem.js";

type MultipartUploadHarness = {
  uploadWithMultipart(
    path: string,
    blob: Blob,
    permissions?: string,
  ): Promise<SuccessResponse>;
  initiateMultipartUpload(
    path: string,
    permissions?: string,
  ): Promise<MultipartInitiateResponse>;
  uploadPart(
    uploadId: string,
    partNumber: number,
    fileBlob: Blob,
  ): Promise<MultipartUploadPartResponse>;
  completeMultipartUpload(
    uploadId: string,
    parts: Array<MultipartPartInfo>,
  ): Promise<SuccessResponse>;
  abortMultipartUpload(uploadId: string): Promise<SuccessResponse>;
};

function createMultipartHarness(): MultipartUploadHarness {
  return Object.create(SandboxFileSystem.prototype) as MultipartUploadHarness;
}

function waitForPartUpload(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 5);
  });
}

describe("SandboxFileSystem multipart upload failure handling", () => {
  it("aborts the multipart upload when a part upload fails", async () => {
    const filesystem = createMultipartHarness();
    const uploadedParts: number[] = [];
    const abortedUploadIds: string[] = [];
    let completeCalled = false;

    filesystem.initiateMultipartUpload = () => {
      return Promise.resolve({ uploadId: "upload-fail" });
    };
    filesystem.uploadPart = async (_uploadId, partNumber) => {
      await waitForPartUpload();
      uploadedParts.push(partNumber);
      if (partNumber === 2) {
        throw new Error("part 2 failed");
      }
      return { partNumber, etag: `etag-${partNumber}` };
    };
    filesystem.completeMultipartUpload = () => {
      completeCalled = true;
      return Promise.resolve({ message: "completed" });
    };
    filesystem.abortMultipartUpload = (uploadId) => {
      abortedUploadIds.push(uploadId);
      return Promise.resolve({ message: "aborted" });
    };

    const blob = new Blob([new Uint8Array(11 * 1024 * 1024)]);

    await expect(
      filesystem.uploadWithMultipart("/tmp/large-file.bin", blob),
    ).rejects.toThrow("part 2 failed");

    expect(abortedUploadIds).toEqual(["upload-fail"]);
    expect(completeCalled).toBe(false);
    expect(uploadedParts).toContain(2);
  });
});
