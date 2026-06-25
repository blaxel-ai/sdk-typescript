import { describe, expect, it } from "vitest";
import { SandboxAction } from "../../@blaxel/core/src/sandbox/action.js";
import { SandboxOperationRecorder } from "../../@blaxel/core/src/sandbox/diagnostics.js";
import { SandboxInstance } from "../../@blaxel/core/src/sandbox/sandbox.js";
import type { SandboxConfiguration } from "../../@blaxel/core/src/sandbox/types.js";

class TestSandboxAction extends SandboxAction {
  async succeed() {
    return this.recordOperation(
      "test",
      "succeed",
      {
        authorization: "Bearer secret",
        command: this.commandDiagnostics("echo super-secret-token"),
      },
      () => Promise.resolve({ bytes: 42 }),
      (result) => ({ resultBytes: result.bytes }),
    );
  }

  async fail() {
    return this.recordOperation(
      "test",
      "fail",
      { path: "/tmp/output.txt" },
      () => Promise.reject(Object.assign(new Error("upstream reset"), { code: "ECONNRESET", status: 503 })),
    );
  }
}

function sandboxConfig(recorder: SandboxOperationRecorder): SandboxConfiguration {
  return {
    metadata: {
      name: "recorder-test",
    },
    status: "READY",
    h2Domain: "any.us-pdx-1.bl.run",
    operationRecorder: recorder,
  } as SandboxConfiguration;
}

describe("SandboxOperationRecorder", () => {
  it("records bounded privacy-safe operation artifacts", async () => {
    let now = 1000;
    const recorder = new SandboxOperationRecorder({
      maxEvents: 1,
      clock: () => {
        now += 25;
        return now;
      },
      now: () => `t-${now}`,
      idFactory: () => `id-${now}`,
    });
    const action = new TestSandboxAction(sandboxConfig(recorder));

    await action.succeed();
    await expect(action.fail()).rejects.toThrow("upstream reset");

    const events = recorder.snapshot();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "id-1050",
      sandboxName: "recorder-test",
      subsystem: "test",
      operation: "fail",
      status: "error",
      durationMs: 25,
      transport: {
        h2Domain: "any.us-pdx-1.bl.run",
        forcedUrl: false,
      },
      attributes: {
        path: "/tmp/output.txt",
      },
      error: {
        name: "Error",
        message: "upstream reset",
        code: "ECONNRESET",
        status: 503,
      },
    });
  });

  it("redacts secret fields and command text unless explicitly enabled", async () => {
    const recorder = new SandboxOperationRecorder({
      captureCommandText: false,
      clock: () => 0,
      now: () => "now",
    });
    const action = new TestSandboxAction(sandboxConfig(recorder));

    await action.succeed();

    const [event] = recorder.snapshot();
    expect(event.attributes?.authorization).toBe("[redacted]");
    expect(event.attributes?.command).toMatchObject({
      commandLength: 23,
      commandText: "[redacted]",
    });
    expect(event.result).toEqual({ resultBytes: 42 });
    expect(recorder.toString()).not.toContain("super-secret-token");
    expect(recorder.toString()).not.toContain("Bearer secret");
  });

  it("can be attached and detached from a SandboxInstance", () => {
    const sandbox = new SandboxInstance({
      metadata: { name: "attach-test" },
      status: "READY",
    } as SandboxConfiguration);

    const recorder = sandbox.startOperationRecording({ maxEvents: 3 });
    expect(sandbox.operationRecorder).toBe(recorder);
    expect(sandbox.stopOperationRecording()).toBe(recorder);
    expect(sandbox.operationRecorder).toBeNull();
  });
});
