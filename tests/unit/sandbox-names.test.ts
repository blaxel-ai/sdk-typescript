import { describe, expect, it } from "vitest";

import {
  SANDBOX_NAME_MAX_LENGTH,
  isValidSandboxName,
  sanitizeSandboxName,
} from "../../@blaxel/core/src/sandbox/index.js";
import { invalidSandboxNameHint } from "../../@blaxel/core/src/sandbox/names.js";

describe("isValidSandboxName", () => {
  it.each(["a", "my-sandbox", "my-sandbox-1", "0abc", "a1-b2-c3", "x".repeat(SANDBOX_NAME_MAX_LENGTH)])(
    "accepts %s",
    (name) => {
      expect(isValidSandboxName(name)).toBe(true);
    },
  );

  it.each([
    "",
    "sesn_01AbC",
    "My-Sandbox",
    "my_sandbox",
    "my.sandbox",
    "my sandbox",
    "-leading",
    "trailing-",
    "double--hyphen",
    "x".repeat(SANDBOX_NAME_MAX_LENGTH + 1),
    undefined,
    42,
  ])("rejects %s", (name) => {
    expect(isValidSandboxName(name)).toBe(false);
  });
});

describe("sanitizeSandboxName", () => {
  it.each([
    ["sesn_01AbC", "sesn-01abc"],
    ["My Sandbox", "my-sandbox"],
    ["__a__b__", "a-b"],
    ["a.b_c d", "a-b-c-d"],
    ["already-valid", "already-valid"],
    ["UPPER", "upper"],
  ])("maps %s to %s", (raw, expected) => {
    expect(sanitizeSandboxName(raw)).toBe(expected);
    expect(isValidSandboxName(sanitizeSandboxName(raw))).toBe(true);
  });

  it("truncates without leaving a trailing hyphen", () => {
    const result = sanitizeSandboxName("a".repeat(SANDBOX_NAME_MAX_LENGTH - 1) + "_bcd");
    expect(result).toBe("a".repeat(SANDBOX_NAME_MAX_LENGTH - 1));
    expect(isValidSandboxName(result)).toBe(true);
  });

  it("keeps long ids within the limit", () => {
    const result = sanitizeSandboxName("Session_" + "X".repeat(100));
    expect(result).toHaveLength(SANDBOX_NAME_MAX_LENGTH);
    expect(isValidSandboxName(result)).toBe(true);
  });

  it.each(["", "___", "!!!", "-"])("throws when %j has no letter or digit", (raw) => {
    expect(() => sanitizeSandboxName(raw)).toThrow(/no letter or digit/);
  });
});

describe("invalidSandboxNameHint", () => {
  it("is empty for a missing or valid name", () => {
    expect(invalidSandboxNameHint(undefined)).toBe("");
    expect(invalidSandboxNameHint("my-sandbox")).toBe("");
  });

  it("states the rule and the sanitized name", () => {
    const hint = invalidSandboxNameHint("sesn_01AbC");
    expect(hint).toContain("lowercase letters, digits and single hyphens");
    expect(hint).toContain('sanitizeSandboxName("sesn_01AbC") gives "sesn-01abc"');
  });

  it("states only the rule when nothing can be kept", () => {
    const hint = invalidSandboxNameHint("___");
    expect(hint).toContain("single hyphens");
    expect(hint).not.toContain("sanitizeSandboxName");
  });
});
