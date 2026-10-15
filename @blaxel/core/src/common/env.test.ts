import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import toml from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalCwd = process.cwd();
const originalWorkspace = process.env.BL_WORKSPACE;
let currentTempDir: string | undefined;

const importEnvFromTempConfig = async (config: string) => {
  currentTempDir = mkdtempSync(join(tmpdir(), "blaxel-env-"));
  writeFileSync(join(currentTempDir, "blaxel.toml"), config);
  process.chdir(currentTempDir);
  vi.resetModules();
  return import("./env.js");
};

afterEach(() => {
  process.chdir(originalCwd);
  if (originalWorkspace === undefined) {
    delete process.env.BL_WORKSPACE;
  } else {
    process.env.BL_WORKSPACE = originalWorkspace;
  }
  delete (Object.prototype as Record<string, unknown>).BL_WORKSPACE;
  delete (Object.prototype as Record<string, unknown>).SECRET_ENV;
  vi.resetModules();
  if (currentTempDir) {
    rmSync(currentTempDir, { force: true, recursive: true });
    currentTempDir = undefined;
  }
});

describe("env TOML configuration", () => {
  it("loads blaxel.toml env values through the SDK env proxy", async () => {
    const { env } = await importEnvFromTempConfig(`
[env]
BL_WORKSPACE = "test-workspace"
BL_API_URL = "https://api.example.test"
`);

    expect(env.BL_WORKSPACE).toBe("test-workspace");
    expect(env.BL_API_URL).toBe("https://api.example.test");
  });

  it("serializes supported TOML env value types through the SDK env proxy", async () => {
    const { env } = await importEnvFromTempConfig(`
[env]
BOOLEAN_VALUE = true
NUMBER_VALUE = 42
ARRAY_VALUE = ["a", "b"]
INLINE_TABLE_VALUE = { name = "sandbox", enabled = true }
MULTILINE_VALUE = """
line one
line two
"""
`);

    expect(env.BOOLEAN_VALUE).toBe("true");
    expect(env.NUMBER_VALUE).toBe("42");
    expect(env.ARRAY_VALUE).toBe('["a","b"]');
    expect(env.INLINE_TABLE_VALUE).toBe('{"name":"sandbox","enabled":true}');
    expect(env.MULTILINE_VALUE).toBe("line one\nline two\n");
  });

  it("bounds array and inline-table nesting in the selected TOML parser", () => {
    const nestedArray = `value = ${"[".repeat(6)}0${"]".repeat(6)}`;
    const nestedInlineTable = `value = ${"{ a = ".repeat(6)}0${"}".repeat(6)}`;

    expect(() => toml.parse(nestedArray, { maxDepth: 5 })).toThrow(/excessively nested structures/);
    expect(() => toml.parse(nestedInlineTable, { maxDepth: 5 })).toThrow(/excessively nested structures/);
  });

  it("uses the SDK loader bounded TOML parser for default config parsing", async () => {
    process.env.BL_WORKSPACE = "process-workspace";
    const nestedArray = `${"[".repeat(101)}0${"]".repeat(101)}`;

    const { env } = await importEnvFromTempConfig(`
[env]
BL_WORKSPACE = "toml-workspace"
TOO_DEEP = ${nestedArray}
`);

    expect(env.BL_WORKSPACE).toBe("process-workspace");
  });

  it("does not load inherited env keys from config or secret sources", async () => {
    delete process.env.BL_WORKSPACE;
    (Object.prototype as Record<string, unknown>).BL_WORKSPACE = "polluted-workspace";
    (Object.prototype as Record<string, unknown>).SECRET_ENV = "polluted-secret";

    const { env } = await importEnvFromTempConfig(`
[env]
LEGITIMATE_ENV = "kept"
`);

    expect(env.BL_WORKSPACE).toBeUndefined();
    expect(env.SECRET_ENV).toBeUndefined();
    expect(env.LEGITIMATE_ENV).toBe("kept");
  });

  it("does not pollute prototypes while loading malicious TOML env keys", async () => {
    delete process.env.BL_WORKSPACE;

    const { env } = await importEnvFromTempConfig(`
[env]
BL_WORKSPACE = "legitimate-workspace"

[env.__proto__]
INJECTED = "polluted-workspace"
`);

    expect(env.BL_WORKSPACE).toBe("legitimate-workspace");
    expect(env.INJECTED).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("INJECTED");
  });
});
