import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { deleteSandboxesWithPrefix } from "./helpers.js";

const execFileAsync = promisify(execFile);
const fixtureRoot = fileURLToPath(new URL("./fixtures/eve-app", import.meta.url));
const temporaryFixtureRoot = fileURLToPath(new URL("./tmp", import.meta.url));
const namePrefix = `eve-agent-${randomUUID().replaceAll("-", "").slice(0, 8)}`;

describe("eve agent on Blaxel", { timeout: 59_000 }, () => {
  afterAll(async () => {
    await deleteSandboxesWithPrefix(namePrefix);
  });

  it("runs all five built-in sandbox tools through a real eve turn", async () => {
    const runRoot = await copyFixtureToTemporaryDirectory();
    let stderr: string;
    let stdout: string;
    try {
      ({ stderr, stdout } = await execFileAsync(
        "bunx",
        ["eve", "eval", "--skip-report", "--verbose"],
        {
          cwd: runRoot,
          env: cleanChildEnvironment(namePrefix),
          maxBuffer: 10 * 1024 * 1024,
          timeout: 55_000,
        },
      ));
    } catch (error) {
      const failure = error as Error & { stderr?: string; stdout?: string };
      throw new Error(
        `eve eval failed.\nstdout:\n${failure.stdout ?? ""}\nstderr:\n${failure.stderr ?? ""}`,
        { cause: error },
      );
    } finally {
      await rm(runRoot, { force: true, recursive: true });
    }

    expect(`${stdout}\n${stderr}`).toContain("Results: 1 passed (1 total)");
    expect(`${stdout}\n${stderr}`).toContain("Gates: 7 passed");
  });
});

async function copyFixtureToTemporaryDirectory(): Promise<string> {
  await mkdir(temporaryFixtureRoot, { recursive: true });
  const runRoot = await mkdtemp(join(temporaryFixtureRoot, "eve-app-"));
  const ignoredRoots = [
    join(fixtureRoot, ".eve"),
    join(fixtureRoot, "node_modules"),
  ];
  await cp(fixtureRoot, runRoot, {
    recursive: true,
    filter(source) {
      return !ignoredRoots.some(
        (ignoredRoot) => source === ignoredRoot || source.startsWith(`${ignoredRoot}${sep}`),
      );
    },
  });
  return runRoot;
}

function cleanChildEnvironment(testNamePrefix: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    BL_EVE_TEST_NAME_PREFIX: testNamePrefix,
    NODE_ENV: "development",
  };
  delete environment.VITEST;
  delete environment.VITEST_POOL_ID;
  delete environment.VITEST_WORKER_ID;
  return environment;
}
