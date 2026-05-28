// Regression: ENG-2680 — the small-file single-PUT upload path (writeBinary for
// a blob at/under the multipart threshold, which most small uploads take and
// which the multipart part-retry never covered) now runs under the same
// retry-on-transient-reset wrapper as multipart parts, AND rebuilds its
// FormData body per attempt so a retried PUT carries a fresh body rather than an
// already-consumed one. This is the path Vivek's failing writeBinary most likely
// hit. Drives the real SandboxFileSystem.writeBinary through a stubbed h2Fetch.
// No creds, no network.
import { afterEach, describe, expect, it } from "vitest";
import { SandboxFileSystem } from "../../../@blaxel/core/src/sandbox/filesystem/filesystem.js";
import { settings } from "../../../@blaxel/core/src/common/settings.js";

type WriteBinaryHarness = {
  writeBinary(path: string, content: Uint8Array): Promise<{ message?: string }>;
};

// A transport reset shaped like the real failure: a top-level "fetch failed"
// wrapping a cause that carries the ECONNRESET code (the form the classifier
// must walk the cause chain to recognize).
function econnreset(): Error {
  return Object.assign(new Error("fetch failed"), {
    cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  });
}

function okResponse() {
  return { ok: true, json: () => Promise.resolve({ message: "written" }) };
}

function httpError(status: number, body: string) {
  return { ok: false, status, text: () => Promise.resolve(body) };
}

/**
 * Build a writeBinary harness whose stubbed h2Fetch follows `behaviors` by
 * attempt (the last entry repeats): a behavior that throws simulates a transport
 * reset, one that returns an object simulates an HTTP response. Records the body
 * object handed to each attempt so a test can prove the FormData is rebuilt.
 */
function harness(behaviors: Array<() => unknown>) {
  const h = Object.create(SandboxFileSystem.prototype) as Record<string, unknown>;
  // url getter reads sandbox.forceUrl; absent h2Domain keeps the PUT off the
  // withUploadSlot gate so this test isolates retry behavior, not concurrency.
  h.sandbox = { forceUrl: "http://edge.test", metadata: { name: "t" } };
  h.formatPath = (p: string) => p;
  const bodies: unknown[] = [];
  let attempts = 0;
  h.h2Fetch = (_url: unknown, init?: { body?: unknown }) => {
    const i = attempts++;
    bodies.push(init?.body);
    const behavior = behaviors[Math.min(i, behaviors.length - 1)];
    // Wrap so a synchronous throw surfaces as a rejected promise, matching how a
    // real reset reaches the retry wrapper.
    return Promise.resolve().then(behavior);
  };
  return {
    fsys: h as unknown as WriteBinaryHarness,
    attempts: () => attempts,
    bodies,
  };
}

describe("ENG-2680: single-PUT (small-file) upload retry", () => {
  afterEach(() => {
    delete settings.config.fsPartRetries;
  });

  it("retries a transient reset on the small-file PUT path and self-heals (on by default)", async () => {
    expect(settings.fsPartRetries).toBe(3); // default-on, no config set
    const { fsys, attempts, bodies } = harness([
      () => {
        throw econnreset();
      },
      () => {
        throw econnreset();
      },
      () => okResponse(),
    ]);

    await expect(
      fsys.writeBinary("/tmp/small.bin", new Uint8Array(16)),
    ).resolves.toEqual({ message: "written" });

    // 1 initial attempt + 2 retries, then success.
    expect(attempts()).toBe(3);
    // Each attempt got a freshly built FormData body, never a reused reference.
    // A consumed/reused body is exactly what would make a "retry" silently send
    // nothing; distinct instances prove the per-attempt rebuild.
    expect(bodies).toHaveLength(3);
    for (const body of bodies) expect(body).toBeInstanceOf(FormData);
    expect(new Set(bodies).size).toBe(3);
  });

  it("does NOT retry a non-transient HTTP failure on the PUT path", async () => {
    const { fsys, attempts } = harness([() => httpError(400, "invalid path")]);

    await expect(
      fsys.writeBinary("/tmp/small.bin", new Uint8Array(16)),
    ).rejects.toThrow("Failed to write binary: 400");
    expect(attempts()).toBe(1); // a 4xx is not transient: no retry
  });

  it("can be turned off on the PUT path (fsPartRetries = 0)", async () => {
    settings.config.fsPartRetries = 0;
    const { fsys, attempts } = harness([
      () => {
        throw econnreset();
      },
    ]);

    await expect(
      fsys.writeBinary("/tmp/small.bin", new Uint8Array(16)),
    ).rejects.toThrow();
    expect(attempts()).toBe(1); // retry disabled: exactly one attempt
  });
});
