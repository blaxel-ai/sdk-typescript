import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import toml from "toml";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalCwd = process.cwd();
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

  it("uses the bounded TOML parser introduced in toml 4.2.0", () => {
    const nestedArray = `value = ${"[".repeat(10)}0${"]".repeat(10)}`;

    expect(() => {
      toml.parse(nestedArray, { maxDepth: 5 });
    }).toThrow(/Maximum nesting depth of 5 exceeded/);
  });
});
