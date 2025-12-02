import { SandboxInstance } from "@blaxel/core";
import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import { createOrGetSandbox } from "../utils";

const sandboxName = "sandbox-test-fswrite-2"

function generateRandomContent(size: number): string {
  const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \n";
  const bytes = randomBytes(size);
  let result = "";
  for (let i = 0; i < size; i++) {
    result += charset[bytes[i] % charset.length];
  }
  return result;
}

async function uploadViaJSON(sandbox: SandboxInstance, path: string, content: string): Promise<bigint> {
  const start = process.hrtime.bigint();
  await sandbox.fs.write(path, content);
  const end = process.hrtime.bigint();
  return end - start;
}

async function uploadViaMultipart(sandbox: SandboxInstance, path: string, content: string): Promise<bigint> {
  const start = process.hrtime.bigint();
  await sandbox.fs.writeBinary(path, Buffer.from(content, "utf-8"));
  const end = process.hrtime.bigint();
  return end - start;
}

function formatNs(ns: bigint): string {
  const ms = Number(ns) / 1e6;
  return `${ms.toFixed(2)}ms (${ns}ns)`;
}

async function performanceComparison(sandbox: SandboxInstance) {
  const testCases: { name: string; size: number }[] = [
    { name: "10B", size: 10 },
    { name: "100B", size: 100 },
    { name: "1KB", size: 1024 },
    { name: "10KB", size: 10 * 1024 },
    { name: "20KB", size: 20 * 1024 },
    { name: "50KB", size: 50 * 1024 },
    { name: "60KB", size: 60 * 1024 },
    { name: "70KB", size: 70 * 1024 },
    { name: "80KB", size: 80 * 1024 },
    { name: "90KB", size: 90 * 1024 },
    { name: "100KB", size: 100 * 1024 },
    { name: "1MB", size: 1024 * 1024 },
    { name: "5MB", size: 5 * 1024 * 1024 },
  ];

  const iterations = 100;

  console.log("\n=== Upload Performance Comparison: JSON vs Multipart ===");
  console.log(`${"Size".padEnd(10)} | ${"JSON (avg)".padEnd(28)} | ${"Multipart (avg)".padEnd(28)} | Speedup`);
  console.log("-----------|------------------------------|------------------------------|--------");

  const rows: string[][] = [];
  rows.push(["size", "json_avg_ns", "multipart_avg_ns", "speedup"]);

  for (const tc of testCases) {
    const content = generateRandomContent(tc.size);

    let jsonTotal = 0n;
    let multipartTotal = 0n;

    for (let i = 0; i < iterations; i++) {
      const jsonPath = `/blaxel/perf/test-json-${tc.name}-${Date.now()}-${i}`;
      const dur = await uploadViaJSON(sandbox, jsonPath, content);
      jsonTotal += dur;
      await sandbox.fs.rm(jsonPath);
    }

    for (let i = 0; i < iterations; i++) {
      const mpPath = `/blaxel/perf/test-multipart-${tc.name}-${Date.now()}-${i}`;
      const dur = await uploadViaMultipart(sandbox, mpPath, content);
      multipartTotal += dur;
      await sandbox.fs.rm(mpPath);
    }

    const jsonAvg = jsonTotal / BigInt(iterations);
    const multipartAvg = multipartTotal / BigInt(iterations);
    const speedup = Number(jsonAvg) / Number(multipartAvg);

    console.log(`${tc.name.padEnd(10)} | ${formatNs(jsonAvg).padEnd(28)} | ${formatNs(multipartAvg).padEnd(28)} | ${speedup.toFixed(2)}x`);

    rows.push([
      tc.name,
      jsonAvg.toString(),
      multipartAvg.toString(),
      speedup.toFixed(4),
    ]);
  }

  await fs.mkdir("reports", { recursive: true });
  const csv = rows.map(r => r.join(",")).join("\n");
  await fs.writeFile("reports/perf_comparison.csv", csv);

  let html = "<html><head><meta charset=\"utf-8\"><title>Upload Comparison</title></head><body>" +
    "<h3>Upload Performance Comparison</h3><table border=\"1\" cellspacing=\"0\" cellpadding=\"4\"><tr><th>Size</th><th>JSON (avg ns)</th><th>Multipart (avg ns)</th><th>Speedup</th></tr>";
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    html += `<tr><td>${row[0]}</td><td>${row[1]}</td><td>${row[2]}</td><td>${row[3]}</td></tr>`;
  }
  html += "</table></body></html>";
  await fs.writeFile("reports/perf_comparison.html", html);
}

try {
  const sandbox = await createOrGetSandbox({ sandboxName, image: "blaxel/base-image:latest" });

  // Ensure base directories exist (mkdir is idempotent on server side)
  try { await sandbox.fs.mkdir("/blaxel/perf"); } catch {}
  try { await sandbox.fs.mkdir("/blaxel/compat"); } catch {}
  try { await sandbox.fs.mkdir("/blaxel/stream"); } catch {}

  await performanceComparison(sandbox);
} catch (e) {
  console.error("There was an error => ", e);
} finally {
  console.log("Deleting sandbox");
  await SandboxInstance.delete(sandboxName)
}
