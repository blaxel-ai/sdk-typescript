import { afterEach, describe, expect, it } from "vitest";
import { env } from "./env.js";
import {
  BUN_H2_FIXED_VERSION,
  H2_DEFAULT_CONNECTION_WINDOW_BYTES,
  detectBunVersion,
  isBrokenBunH2Runtime,
  isBrokenBunVersion,
  parseSemver,
} from "./h2-runtime.js";

// The Bun H2 flow-control bug (never sends connection-level WINDOW_UPDATE, so a
// pooled session freezes after 65535 cumulative body bytes) was fixed in
// 1.3.11. Everything below < 1.3.11 must be classified "broken"; >= 1.3.11 must
// be "fixed". A non-Bun runtime (no version) is never broken. This is the
// single most important gate in the SDK's H2 story, so we pin it exhaustively.

describe("parseSemver", () => {
  it("parses a plain major.minor.patch triple", () => {
    expect(parseSemver("1.3.11")).toEqual([1, 3, 11]);
    expect(parseSemver("0.0.0")).toEqual([0, 0, 0]);
    expect(parseSemver("22.14.0")).toEqual([22, 14, 0]);
  });

  it("tolerates missing minor/patch", () => {
    expect(parseSemver("2")).toEqual([2, 0, 0]);
    expect(parseSemver("1.4")).toEqual([1, 4, 0]);
  });

  it("strips pre-release and build metadata before comparing", () => {
    expect(parseSemver("1.3.11-canary.1")).toEqual([1, 3, 11]);
    expect(parseSemver("1.3.10-debug")).toEqual([1, 3, 10]);
    expect(parseSemver("1.4.0+build.7")).toEqual([1, 4, 0]);
    expect(parseSemver("2.0.0-alpha+exp.sha.5114f85")).toEqual([2, 0, 0]);
  });

  it("returns null for absent or non-numeric input", () => {
    expect(parseSemver(undefined)).toBeNull();
    expect(parseSemver(null)).toBeNull();
    expect(parseSemver("")).toBeNull();
    expect(parseSemver("latest")).toBeNull();
    expect(parseSemver("v1.2.3")).toBeNull();
    expect(parseSemver("1.x.0")).toBeNull();
  });
});

describe("isBrokenBunVersion", () => {
  it("treats a missing version as not-Bun (never broken)", () => {
    expect(isBrokenBunVersion(undefined)).toBe(false);
    expect(isBrokenBunVersion(null)).toBe(false);
    expect(isBrokenBunVersion("")).toBe(false);
  });

  // The full boundary matrix. Left column = Bun version string, right = whether
  // the pooled H2 transport is broken on it.
  const matrix: Array<[string, boolean]> = [
    // Ancient / pre-1.0 — all broken.
    ["0.1.0", true],
    ["0.8.1", true],
    ["0.9.9", true],
    // 1.0.x – 1.2.x — broken.
    ["1.0.0", true],
    ["1.1.34", true],
    ["1.2.0", true],
    ["1.2.21", true],
    // 1.3.0 – 1.3.10 — the affected line, still broken.
    ["1.3.0", true],
    ["1.3.1", true],
    ["1.3.9", true],
    ["1.3.10", true],
    // 1.3.11 — the exact fix boundary. Fixed.
    ["1.3.11", false],
    // Everything after — fixed.
    ["1.3.12", false],
    ["1.3.100", false],
    ["1.4.0", false],
    ["1.10.0", false],
    ["2.0.0", false],
    ["10.0.0", false],
  ];

  it.each(matrix)("Bun %s -> broken=%s", (version, expected) => {
    expect(isBrokenBunVersion(version)).toBe(expected);
  });

  // Pre-release / canary builds must compare by their release numbers so a
  // "1.3.11-canary" is treated as fixed and a "1.3.10-debug" as broken. This is
  // the exact parse subtlety the earlier duplicated gate got wrong.
  const prereleaseMatrix: Array<[string, boolean]> = [
    ["1.3.10-canary.20250101", true],
    ["1.3.11-canary.20250101", false],
    ["1.3.11-debug", false],
    ["1.4.0-canary", false],
    ["1.2.99-alpha", true],
  ];

  it.each(prereleaseMatrix)(
    "Bun %s (pre-release) -> broken=%s",
    (version, expected) => {
      expect(isBrokenBunVersion(version)).toBe(expected);
    },
  );

  it("classifies an unparseable Bun version as broken (safe default)", () => {
    // A non-empty but unrecognizable version means we cannot prove it is safe,
    // so we err toward disabling H2.
    expect(isBrokenBunVersion("weird-build")).toBe(true);
    expect(isBrokenBunVersion("nightly")).toBe(true);
  });

  it("agrees with the documented fix boundary constant", () => {
    const [maj, min, patch] = parseSemver(BUN_H2_FIXED_VERSION)!;
    // One patch below the fix is broken; the fix itself is not.
    expect(isBrokenBunVersion(`${maj}.${min}.${patch - 1}`)).toBe(true);
    expect(isBrokenBunVersion(`${maj}.${min}.${patch}`)).toBe(false);
  });
});

describe("detectBunVersion / isBrokenBunH2Runtime (current runtime)", () => {
  it("reports the running Bun version, or undefined off Bun", () => {
    const detected = detectBunVersion();
    const actual = globalThis.process?.versions?.bun;
    expect(detected).toBe(actual);
  });

  it("runtime predicate matches the version predicate for this runtime", () => {
    expect(isBrokenBunH2Runtime()).toBe(isBrokenBunVersion(detectBunVersion()));
  });
});

describe("H2_DEFAULT_CONNECTION_WINDOW_BYTES", () => {
  it("is 2^16 - 1 (the window a broken Bun never grows)", () => {
    expect(H2_DEFAULT_CONNECTION_WINDOW_BYTES).toBe(65535);
    expect(H2_DEFAULT_CONNECTION_WINDOW_BYTES).toBe(2 ** 16 - 1);
  });
});

// End-to-end: the settings.disableH2 getter must honor the runtime gate. We
// simulate different Bun versions by injecting process.versions.bun, since the
// getter reads it live on every access.
describe("settings.disableH2 honors the Bun version gate", () => {
  const originalBun = globalThis.process?.versions?.bun;

  afterEach(async () => {
    if (globalThis.process?.versions) {
      if (originalBun === undefined) {
        delete (globalThis.process.versions as Record<string, unknown>).bun;
      } else {
        (globalThis.process.versions as Record<string, string>).bun = originalBun;
      }
    }
    delete (env as Record<string, unknown>).BL_DISABLE_H2;
    const { settings } = await import("./settings.js");
    delete settings.config.disableH2;
  });

  function setBunVersion(version: string | undefined) {
    if (!globalThis.process?.versions) return false;
    if (version === undefined) {
      delete (globalThis.process.versions as Record<string, unknown>).bun;
    } else {
      (globalThis.process.versions as Record<string, string>).bun = version;
    }
    return true;
  }

  it("forces H2 OFF on a broken Bun regardless of config/env", async () => {
    if (!setBunVersion("1.3.10")) return;
    delete (env as Record<string, unknown>).BL_DISABLE_H2;
    const { settings } = await import("./settings.js");
    // Even explicitly asking for H2 on cannot override the safety gate.
    settings.config.disableH2 = false;
    expect(settings.disableH2).toBe(true);
  });

  it("leaves H2 ON (default) on a fixed Bun", async () => {
    if (!setBunVersion("1.3.11")) return;
    delete (env as Record<string, unknown>).BL_DISABLE_H2;
    const { settings } = await import("./settings.js");
    delete settings.config.disableH2;
    expect(settings.disableH2).toBe(false);
  });

  it("still respects an explicit opt-out on a fixed Bun", async () => {
    if (!setBunVersion("1.4.0")) return;
    const { settings } = await import("./settings.js");
    settings.config.disableH2 = true;
    expect(settings.disableH2).toBe(true);
  });
});
