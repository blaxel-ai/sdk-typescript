import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SandboxInstance, type StreamLogsOptions } from "@blaxel/core";
import { defaultImage, defaultLabels, defaultRegion, uniqueName } from "./helpers.js";

describe("source-preserving process log streams", () => {
  const name = uniqueName("process-log-stream");
  let sandbox: SandboxInstance | undefined;

  beforeAll(async () => {
    sandbox = await SandboxInstance.create({ name, image: defaultImage, region: defaultRegion, memory: 2048, labels: defaultLabels });
  });

  afterAll(async () => {
    // The API may have created the named resource even if its response was lost.
    await SandboxInstance.delete(name);
  });

  it("preserves interleaved partial lines, CRLF, split UTF-8 and binary bytes live and on replay", async () => {
    if (!sandbox) throw new Error("Sandbox not created");
    const target = sandbox;
    const processName = "fidelity";
    // Wait for READY through the live log stream before releasing stdin.
    // Short sleeps help the collector observe partial writes separately.
    const script = 'import os,sys,time; os.write(2,b"READY\\n"); sys.stdin.buffer.readline(); os.write(1,b"OUT"); time.sleep(.1); os.write(2,b"ERR\\n"); time.sleep(.1); os.write(1,b"TAIL\\n\\nthree\\r\\n\\xe2"); time.sleep(.1); os.write(2,b"err-tail"); os.write(1,b"\\x82\\xac\\xff\\n")';
    await target.process.exec({ name: processName, command: `python3 -c '${script}'`, stdin: true });
    const expectedStdout = [...Buffer.from("OUTTAIL\n\nthree\r\n€"), 0xff, 10];
    const expectedStderr = [...Buffer.from("READY\nERR\nerr-tail")];
    const read = () => {
      const stdout: number[] = [], stderr: number[] = [];
      const stdoutLines: string[] = [], stderrLines: string[] = [];
      let markReady!: () => void;
      const ready = new Promise<void>(resolve => { markReady = resolve; });
      const options: StreamLogsOptions = {
        onStdoutChunk: bytes => stdout.push(...bytes),
        onStderrChunk: bytes => stderr.push(...bytes),
        onStdout: line => stdoutLines.push(line),
        onStderr: line => { stderrLines.push(line); if (line === "READY") markReady(); },
      };
      const stream = target.process.streamLogs(processName, options);
      return { stream, ready, stdout, stderr, stdoutLines, stderrLines };
    };
    const live = read();
    try {
      await Promise.race([
        live.ready,
        live.stream.wait().then(() => { throw new Error("Log stream ended before READY"); }),
      ]);
      await target.process.writeStdin(processName, "go\n");
      await target.process.closeStdin(processName);
      await live.stream.wait();
      const replay = read();
      try {
        await replay.stream.wait();
        for (const observed of [live, replay]) {
          expect(observed.stdout).toEqual(expectedStdout);
          expect(observed.stderr).toEqual(expectedStderr);
          expect(observed.stdoutLines).toEqual(["OUTTAIL", "", "three", "€�"]);
          expect(observed.stderrLines).toEqual(["READY", "ERR", "err-tail"]);
        }
      } finally {
        replay.stream.close();
      }
    } finally {
      live.stream.close();
    }
  }, 30_000);
});
