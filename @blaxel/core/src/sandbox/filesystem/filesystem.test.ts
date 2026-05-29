import { describe, expect, it } from "vitest";
import { MultipartInitiateResponse, MultipartPartInfo, MultipartUploadPartResponse, SuccessResponse } from "../client/index.js";
import { SandboxFileSystem } from "./filesystem.js";

type MultipartUploadHarness = {
  uploadWithMultipart: (path: string, blob: Blob, permissions?: string) => Promise<SuccessResponse>;
  initiateMultipartUpload: (path: string, permissions?: string) => Promise<MultipartInitiateResponse>;
  uploadPart: (uploadId: string, partNumber: number, fileBlob: Blob) => Promise<MultipartUploadPartResponse>;
  completeMultipartUpload: (uploadId: string, parts: Array<MultipartPartInfo>) => Promise<SuccessResponse>;
  abortMultipartUpload: (uploadId: string) => Promise<SuccessResponse>;
};

const waitForPartUpload = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("SandboxFileSystem multipart upload", () => {
  it("limits concurrent part uploads", async () => {
    const filesystem = Object.create(SandboxFileSystem.prototype) as MultipartUploadHarness;
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

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(uploadedParts.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(completedParts.map((part) => part.partNumber)).toEqual([1, 2, 3, 4]);
  });
});
