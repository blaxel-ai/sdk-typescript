import { randomUUID } from "node:crypto";

import {
  defineBashTool,
  defineGlobTool,
  defineGrepTool,
  type ToolContext,
} from "eve/tools";
import { afterAll, describe, expect, it } from "vitest";

import { blaxel } from "../src/index.js";
import { deleteSandboxesWithPrefix } from "./helpers.js";

describe("eve tools on Blaxel", { timeout: 59_000 }, () => {
  const namePrefix = `eve-tools-${randomUUID().replaceAll("-", "").slice(0, 8)}`;

  afterAll(async () => {
    await deleteSandboxesWithPrefix(namePrefix);
  });

  it("runs eve bash, glob, and grep through the Blaxel backend", async () => {
    const backend = blaxel({
      image: process.env.BL_EVE_TEST_IMAGE ?? "blaxel/ts-app:latest",
      labels: {
        env: "integration-test",
        language: "typescript",
        "created-by": "vitest-integration",
      },
      namePrefix,
      region: process.env.BL_REGION ?? "us-was-1",
    });
    const handle = await backend.create({
      runtimeContext: { appRoot: "/app" },
      sessionKey: "eve-tools-session",
      templateKey: null,
    });
    const context = {
      getSandbox: () => Promise.resolve(handle.session),
    } as ToolContext;

    expect(
      await defineBashTool().execute(
        {
          command:
            "mkdir -p durable && printf 'eve-tools-live-ok\\n' > durable/eve-tools.txt",
        },
        context,
      ),
    ).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "",
      truncated: false,
    });

    const globResult = await defineGlobTool().execute(
      { pattern: "**/eve-tools.txt" },
      context,
    );
    expect(globResult).toEqual(
      expect.objectContaining({ count: 1, truncated: false }),
    );
    expect(JSON.stringify(globResult)).toContain("durable/eve-tools.txt");

    const grepResult = await defineGrepTool().execute(
      { literal: true, pattern: "eve-tools-live-ok" },
      context,
    );
    expect(grepResult).toEqual(
      expect.objectContaining({ matchCount: 1, truncated: false }),
    );
    expect(JSON.stringify(grepResult)).toContain("eve-tools-live-ok");

    await handle.shutdown();
  });
});
