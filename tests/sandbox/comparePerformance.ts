import { BlaxelMcpClientTransport, SandboxInstance, settings } from "@blaxel/core";
import { Client as ModelContextProtocolClient } from "@modelcontextprotocol/sdk/client/index.js";
import { performance } from "perf_hooks";
import WebSocket from "ws";
import { createOrGetSandbox } from "../utils";

const sandboxName = "sandbox-test-3"
const NUM_WRITES = 100; // Number of writes to perform
const CONCURRENCY = 10; // Number of concurrent writes

function percentile(arr: number[], p: number) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[idx];
}

async function sendMessage(ws: WebSocket, fileName: string, content: string) {
  const message = {
    method: "tools/call",
    params: {
      name: "fsWriteFile",
      arguments: { path: fileName, content: content }
    },
    jsonrpc: "2.0",
    id: 2
  }
  await new Promise<void>((resolve, reject) => {
    ws.send(JSON.stringify(message), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function runBatches<T>(
  numTasks: number,
  concurrency: number,
  taskFn: (i: number) => Promise<T>
): Promise<{ results: T[]; durations: number[] }> {
  const durations: number[] = [];
  const results: T[] = [];
  for (let i = 0; i < numTasks; i += concurrency) {
    const batch: Promise<void>[] = [];
    for (let j = 0; j < concurrency && i + j < numTasks; j++) {
      const idx = i + j;
      const start = performance.now();
      batch.push(
        taskFn(idx).then((result) => {
          const end = performance.now();
          durations.push(end - start);
          results.push(result);
        })
      );
    }
    await Promise.all(batch);
  }
  return { results, durations };
}

async function withWebSocket(sandbox: SandboxInstance) {
  return new Promise((resolve, reject) => {
    const url = `${settings.runUrl}/${settings.workspace}/sandboxes/${sandboxName}`
    const ws = new WebSocket(url.replace("http", "ws"), {
        headers: settings.headers
    })
    ws.onopen = async () => {
      console.log("Starting Websocket test")
      const { durations } = await runBatches(
        NUM_WRITES,
        CONCURRENCY,
        (i) => {
          const fileName = `/blaxel/tmp/testfile_${i}.txt`;
          const content = `Test content ${i}`;
          return sendMessage(ws, fileName, content);
        }
      );
      // Calculate stats
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      const mean = avg;
      const p90 = percentile(durations, 90);
      const p99 = percentile(durations, 99);

      console.log(`Writes: ${durations.length}`);
      console.log(`Avg: ${avg.toFixed(2)} ms`);
      console.log(`Mean: ${mean.toFixed(2)} ms`);
      console.log(`p90: ${p90.toFixed(2)} ms`);
      console.log(`p99: ${p99.toFixed(2)} ms`);
      resolve(true)
      ws.close()
    }
    ws.onerror = (error) => {
      console.error("Error from Websocket", error)
      reject(error)
    }
    ws.onclose = () => {
      console.log("Disconnected from Websocket")
    }
  })
}

async function withMCP(sandbox: SandboxInstance) {
  const url = `${settings.runUrl}/${settings.workspace}/sandboxes/${sandboxName}`
  const transport = new BlaxelMcpClientTransport(
    url.toString(),
    settings.headers,
  );
  const client = new ModelContextProtocolClient(
    {
      name: "mcp-sandbox-api",
      version: "1.0.0",
    },
    { capabilities: { tools: {} } }
  );
  await client.connect(transport)
  const { durations } = await runBatches(
    NUM_WRITES,
    CONCURRENCY,
    (i) => {
      const fileName = `/blaxel/tmp/testfile_${i}.txt`;
      const content = `Test content ${i}`;
      return client.callTool({name: "fsWriteFile", arguments: {path: fileName, content: content}})
    }
  );
  // Calculate stats
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  const mean = avg;
  const p90 = percentile(durations, 90);
  const p99 = percentile(durations, 99);

  console.log(`Writes: ${durations.length}`);
  console.log(`Avg: ${avg.toFixed(2)} ms`);
  console.log(`Mean: ${mean.toFixed(2)} ms`);
  console.log(`p90: ${p90.toFixed(2)} ms`);
  console.log(`p99: ${p99.toFixed(2)} ms`);
  await client.close()
}

async function withSdk(sandbox: SandboxInstance) {
  const { durations } = await runBatches(
    NUM_WRITES,
    CONCURRENCY,
    (i) => {
      const fileName = `/blaxel/tmp/testfile_${i}.txt`;
      const content = `Test content ${i}`;
      return sandbox.fs.write(fileName, content);
    }
  );

  // Calculate stats
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  const mean = avg;
  const p90 = percentile(durations, 90);
  const p99 = percentile(durations, 99);

  console.log(`Writes: ${durations.length}`);
  console.log(`Avg: ${avg.toFixed(2)} ms`);
  console.log(`Mean: ${mean.toFixed(2)} ms`);
  console.log(`p90: ${p90.toFixed(2)} ms`);
  console.log(`p99: ${p99.toFixed(2)} ms`);
}

async function main() {
  console.log("Starting test...")
  try {
    // Test with controlplane
    console.log("Starting SDK test")
    const sandbox = await createOrGetSandbox({sandboxName})
    await withSdk(sandbox)
    console.log("Finished SDK test")
    const files = await sandbox.fs.ls("/blaxel/tmp")
    console.log("Files in /blaxel/tmp:", files.files?.length)
    await sandbox.fs.rm("/blaxel/tmp", true)
    console.log("--------------------------------")

    await withWebSocket(sandbox)
    console.log("Finished WebSocket test")
    const files2 = await sandbox.fs.ls("/blaxel/tmp")
    console.log("Files in /blaxel/tmp:", files2.files?.length)
    await sandbox.fs.rm("/blaxel/tmp", true)
    console.log("--------------------------------")

    console.log("Starting MCP test")
    await withMCP(sandbox)
    console.log("Finished MCP test")
    const files3 = await sandbox.fs.ls("/blaxel/tmp")
    console.log("Files in /blaxel/tmp:", files3.files?.length)
    await sandbox.fs.rm("/blaxel/tmp", true)
    console.log("--------------------------------")
  } catch (e) {
    console.error("There was an error => ", e);
  }
}

main()
