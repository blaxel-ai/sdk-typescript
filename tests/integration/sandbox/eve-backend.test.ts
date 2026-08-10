import { SandboxInstance } from "@blaxel/core";
import { afterAll, describe, expect, it } from "vitest";

import { blaxel } from "../../../@blaxel/eve-sandbox/src/index.js";
import {
  defaultImage,
  defaultLabels,
  defaultRegion,
  uniqueName,
} from "./helpers.js";

describe("Blaxel eve sandbox backend", { timeout: 59_000 }, () => {
  const namePrefix = uniqueName("eve");

  afterAll(async () => {
    const page = await SandboxInstance.list({
      limit: 100,
      q: namePrefix,
      showTerminated: true,
    });
    const results = await Promise.allSettled(
      page.data
        .filter((sandbox) => sandbox.metadata.name?.startsWith(`${namePrefix}-`))
        .map((sandbox) => sandbox.delete()),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason as unknown);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Failed to delete ${failures.length} Blaxel test sandbox${failures.length === 1 ? "" : "es"}.`,
      );
    }
  });

  const options = {
    image: defaultImage,
    labels: defaultLabels,
    namePrefix,
    region: defaultRegion,
  };

  it("runs and reconnects a durable eve session", async () => {
    const firstBackend = blaxel(options);
    const firstHandle = await firstBackend.create({
      runtimeContext: { appRoot: "/app" },
      sessionKey: "integration-base-session",
      tags: { test: "eve-backend" },
      templateKey: null,
    });

    expect(
      await firstHandle.session.run({ command: "printf 'eve-live-ok'" }),
    ).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "eve-live-ok",
    });
    expect(
      await firstHandle.session.run({ command: "printf 'line-one\\nline-two\\n'" }),
    ).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "line-one\nline-two\n",
    });
    const background = await firstHandle.session.spawn({
      command: "sleep 0.2; printf 'spawn-live-ok'",
    });
    const [backgroundStdout, backgroundStderr, backgroundResult] = await Promise.all([
      streamToText(background.stdout),
      streamToText(background.stderr),
      background.wait(),
    ]);
    expect(backgroundResult).toEqual({ exitCode: 0 });
    expect(backgroundStdout).toBe("spawn-live-ok");
    expect(backgroundStderr).toBe("");

    await firstHandle.session.writeTextFile({
      path: "durable/session.txt",
      content: "persists-across-backend-instances",
    });
    const binary = new Uint8Array([0, 1, 127, 128, 255]);
    await firstHandle.session.writeBinaryFile({ path: "durable/session.bin", content: binary });
    expect(await firstHandle.session.readBinaryFile({ path: "durable/session.bin" })).toEqual(
      binary,
    );
    const state = await firstHandle.captureState();
    await firstHandle.shutdown();

    const secondBackend = blaxel(options);
    const secondHandle = await secondBackend.create({
      existingMetadata: state.metadata,
      runtimeContext: { appRoot: "/new-process" },
      sessionKey: state.sessionKey,
      templateKey: null,
    });

    expect(await secondHandle.session.readTextFile({ path: "durable/session.txt" })).toBe(
      "persists-across-backend-instances",
    );
    expect(await secondHandle.session.readBinaryFile({ path: "durable/session.bin" })).toEqual(
      binary,
    );
    expect((await secondHandle.captureState()).metadata).toEqual(state.metadata);
    await secondHandle.session.setNetworkPolicy("deny-all");
    const blocked = await secondHandle.session.run({
      command: "curl -sS --max-time 3 -o /dev/null https://example.com",
    });
    expect(blocked.exitCode).not.toBe(0);
    await secondHandle.shutdown();
  });

  it("enforces eve deny-all before the first command", async () => {
    const backend = blaxel({ ...options, networkPolicy: "deny-all" });
    const handle = await backend.create({
      runtimeContext: { appRoot: "/app" },
      sessionKey: "integration-network-session",
      templateKey: null,
    });

    const result = await handle.session.run({
      command: "curl -sS --max-time 3 -o /dev/null https://example.com",
    });
    expect(result.exitCode).not.toBe(0);
    await handle.shutdown();
  });
});

async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return result + decoder.decode();
      result += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
