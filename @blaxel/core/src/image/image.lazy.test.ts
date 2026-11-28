/**
 * @vitest-environment node
 *
 * Regression test for "Cannot find module 'readable-stream/passthrough'"
 * (Sentry SDK-JS-5T). Importing the image module must NOT eagerly load
 * `archiver`: a top-level `import archiver` drags in the
 * archiver -> lazystream -> readable-stream chain for every consumer of
 * `@blaxel/core` (which re-exports this module), and that chain breaks under
 * bundlers that dedupe readable-stream to v4. `archiver` is only needed when a
 * build zips a context, so it is loaded lazily inside `_createZip`.
 */
import { describe, expect, it, vi } from "vitest";

// Make `archiver` fail loudly on load. If anything imports it at module
// evaluation time, importing the image module below throws and this test fails.
vi.mock("archiver", () => {
  throw new Error("archiver must be loaded lazily, not at module import time");
});

describe("image module lazily loads archiver", () => {
  it("imports and builds a dockerfile without loading archiver", async () => {
    const { ImageInstance } = await import("./image.js");

    const image = ImageInstance.fromRegistry("python:3.11-slim")
      .workdir("/app")
      .runCommands("echo hello");

    expect(image.dockerfile).toContain("FROM python:3.11-slim");
    expect(image.dockerfile).toContain("WORKDIR /app");
    expect(image.hash).toHaveLength(12);
  });
});
