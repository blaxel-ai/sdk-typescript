import { afterAll, beforeAll, expect, it } from "vitest";
import { SandboxInstance } from "@blaxel/core";
import { defaultImage, defaultLabels, defaultRegion, uniqueName } from "./helpers.js";

const localUrl = process.env.LOCAL_PROCESS_API_URL;
const sandboxName = uniqueName("process-recovery");
let sandbox: SandboxInstance;

beforeAll(async () => {
  sandbox = localUrl
    ? new SandboxInstance({ metadata: { name: sandboxName }, spec: {}, forceUrl: localUrl, headers: {} })
    : await SandboxInstance.create({ name: sandboxName, image: defaultImage, region: defaultRegion, labels: defaultLabels });
});

afterAll(async () => {
  if (!localUrl) await SandboxInstance.delete(sandboxName);
});

it("wait recovers a lost status response without executing the command twice", async () => {
  const name = uniqueName("interrupted-command");
  const marker = `/tmp/${name}`;
  const transport = sandbox.process.client;
  const fetch = transport.getConfig().fetch ?? globalThis.fetch;
  let reads = 0;
  let starts = 0;
  transport.setConfig({ fetch: async (request) => {
    if (request.method === "POST") starts++;
    const response = await fetch(request);
    if (request.method === "GET" && ++reads === 2) {
      // The status request reached the real server, but its response is lost.
      await response.arrayBuffer();
      await sandbox.fs.write(`${marker}.release`, "continue");
      throw new TypeError("Failed to fetch");
    }
    return response;
  } });
  Object.defineProperty(sandbox.process, "client", { value: transport, configurable: true });
  try {
    await sandbox.process.exec({
      name,
      command: `echo started >> ${marker}; while [ ! -f ${marker}.release ]; do sleep 0.1; done; echo recovered-output; exit 7`,
      waitForCompletion: false,
      keepAlive: false,
    });
    const result = await sandbox.process.wait(name, { maxWait: 10_000, interval: 100 });
    expect(result.name).toBe(name);
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(7);
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(await sandbox.process.logs(name)).toContain("recovered-output");
    expect(await sandbox.fs.read(marker)).toBe("started\n");
    expect(starts).toBe(1);
  } finally {
    await sandbox.process.kill(name).catch(() => {});
    Reflect.deleteProperty(sandbox.process, "client");
    await sandbox.fs.rm(marker).catch(() => {});
    await sandbox.fs.rm(`${marker}.release`).catch(() => {});
  }
}, 30_000);
