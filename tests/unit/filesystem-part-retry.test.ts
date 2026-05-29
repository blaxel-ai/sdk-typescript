import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  MultipartInitiateResponse,
  MultipartPartInfo,
  MultipartUploadPartResponse,
  SuccessResponse,
} from "../../@blaxel/core/src/sandbox/client/index.js";
import { SandboxFileSystem } from "../../@blaxel/core/src/sandbox/filesystem/filesystem.js";
import { settings } from "../../@blaxel/core/src/common/settings.js";

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

// A blob just over the 5MB multipart threshold yields exactly two parts (the
// 5MB chunk size means ceil(6MB / 5MB) === 2). The tests below target a single
// part (part 2) for failure so retry counts for that part are unambiguous.
function multiPartBlob(): Blob {
  return new Blob([new Uint8Array(6 * 1024 * 1024)]);
}

describe("SandboxFileSystem part-upload retry", () => {
  afterEach(() => {
    delete settings.config.fsPartRetries;
  });

  /**
   * Build a harness whose part 1 always succeeds and whose part 2 rejects with
   * `error` until `failTimes` rejections have been produced, then succeeds.
   * Returns a getter for the number of times part 2 was attempted.
   */
  function harnessFailingPart2(
    error: unknown,
    failTimes = Number.POSITIVE_INFINITY,
  ): { harness: MultipartUploadHarness; part2Attempts: () => number } {
    const harness = createMultipartHarness();
    let part2Attempts = 0;
    harness.initiateMultipartUpload = () => Promise.resolve({ uploadId: "u" });
    harness.uploadPart = (_uploadId, partNumber) => {
      if (partNumber !== 2) {
        return Promise.resolve({ partNumber, etag: `etag-${partNumber}` });
      }
      part2Attempts++;
      if (part2Attempts <= failTimes) {
        return Promise.reject(error);
      }
      return Promise.resolve({ partNumber, etag: `etag-${partNumber}` });
    };
    harness.completeMultipartUpload = () =>
      Promise.resolve({ message: "completed" });
    harness.abortMultipartUpload = () => Promise.resolve({ message: "aborted" });
    return { harness, part2Attempts: () => part2Attempts };
  }

  describe("transient error classification", () => {
    beforeEach(() => {
      settings.config.fsPartRetries = 3;
    });

    it("retries an ECONNRESET error code on the cause", async () => {
      const { harness, part2Attempts } = harnessFailingPart2(
        Object.assign(new Error("fetch failed"), {
          cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
        }),
        1,
      );
      await expect(
        harness.uploadWithMultipart("/tmp/f.bin", multiPartBlob()),
      ).resolves.toEqual({ message: "completed" });
      expect(part2Attempts()).toBe(2);
    });

    it("retries an ENHANCE_YOUR_CALM H2 reset marker", async () => {
      const { harness, part2Attempts } = harnessFailingPart2(
        new Error("HTTP/2 stream reset: ENHANCE_YOUR_CALM"),
        1,
      );
      await expect(
        harness.uploadWithMultipart("/tmp/f.bin", multiPartBlob()),
      ).resolves.toEqual({ message: "completed" });
      expect(part2Attempts()).toBe(2);
    });

    it("retries the transport's own GOAWAY-before-response message", async () => {
      const { harness, part2Attempts } = harnessFailingPart2(
        new Error("HTTP/2 session sent GOAWAY before response"),
        1,
      );
      await expect(
        harness.uploadWithMultipart("/tmp/f.bin", multiPartBlob()),
      ).resolves.toEqual({ message: "completed" });
      expect(part2Attempts()).toBe(2);
    });

    it("does NOT retry a bare 'fetch failed' with no transport code (avoids over-matching)", async () => {
      const { harness, part2Attempts } = harnessFailingPart2(
        new Error("fetch failed"),
      );
      await expect(
        harness.uploadWithMultipart("/tmp/f.bin", multiPartBlob()),
      ).rejects.toThrow("fetch failed");
      // No retry: the error never qualified as transient.
      expect(part2Attempts()).toBe(1);
    });

    it("does NOT retry an application 'INTERNAL_ERROR' response body (avoids over-matching)", async () => {
      const { harness, part2Attempts } = harnessFailingPart2(
        new Error('{"error":"INTERNAL_ERROR: disk full"}'),
      );
      await expect(
        harness.uploadWithMultipart("/tmp/f.bin", multiPartBlob()),
      ).rejects.toThrow("INTERNAL_ERROR");
      expect(part2Attempts()).toBe(1);
    });

    it("does NOT retry an ordinary 4xx validation error", async () => {
      const { harness, part2Attempts } = harnessFailingPart2(
        new Error("400 Bad Request: invalid part number"),
      );
      await expect(
        harness.uploadWithMultipart("/tmp/f.bin", multiPartBlob()),
      ).rejects.toThrow("400 Bad Request");
      expect(part2Attempts()).toBe(1);
    });
  });

  describe("retry budget", () => {
    it("is disabled by default (fsPartRetries unset = 0, no retries)", async () => {
      // No settings.config.fsPartRetries set.
      const { harness, part2Attempts } = harnessFailingPart2(
        Object.assign(new Error("reset"), { code: "ECONNRESET" }),
      );
      await expect(
        harness.uploadWithMultipart("/tmp/f.bin", multiPartBlob()),
      ).rejects.toThrow("reset");
      // Default-off: exactly one attempt for the failing part, no retry.
      expect(part2Attempts()).toBe(1);
    });

    it("stops after exhausting the configured retry budget", async () => {
      settings.config.fsPartRetries = 2;
      const { harness, part2Attempts } = harnessFailingPart2(
        Object.assign(new Error("reset"), { code: "ECONNRESET" }),
      );
      await expect(
        harness.uploadWithMultipart("/tmp/f.bin", multiPartBlob()),
      ).rejects.toThrow("reset");
      // 1 initial attempt + 2 retries = 3 total for the failing part.
      expect(part2Attempts()).toBe(3);
    });
  });
});
