/**
 * Reproducer for 504 Gateway Timeout error handling in the Blaxel TypeScript SDK.
 *
 * Part 1: Mock 504 server — verifies all SDK methods throw clean errors (not JSON parse errors)
 * Part 2: Real dev sandbox — regression test for normal operations
 *
 * Usage:
 *   export BL_ENV=dev
 *   export BL_API_KEY=<your-api-key>
 *   export BL_WORKSPACE=<your-workspace>
 *   cd <sdk-typescript-repo>
 *   tsx reproducer_504.ts
 */

import http from "node:http";
import { AddressInfo } from "node:net";
import { SandboxInstance } from "@blaxel/core";

// ============================================================
// Part 1: Mock 504 server tests
// ============================================================

const HTML_504_BODY = `<html>
<head><title>504 Gateway Time-out</title></head>
<body>
<center><h1>504 Gateway Time-out</h1></center>
<hr><center>nginx</center>
</body>
</html>`;

function startMockServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(504, { "Content-Type": "text/html" });
      res.end(HTML_504_BODY);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function testMock504ErrorHandling(): Promise<{ passed: number; failed: number }> {
  const server = await startMockServer();
  const addr = server.address() as AddressInfo;
  const mockUrl = `http://127.0.0.1:${addr.port}`;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`PART 1: Testing 504 error handling with mock server on ${mockUrl}`);
  console.log(`${"=".repeat(60)}\n`);

  // Create a SandboxInstance pointing to our mock server via fromSession
  const sandbox = await SandboxInstance.fromSession({
    name: "test-504",
    url: mockUrl,
    token: "fake-token",
    expiresAt: new Date(Date.now() + 3600000),
  });

  let passed = 0;
  let failed = 0;
  let total = 0;

  async function assertRaisesCleanError(
    fn: () => Promise<any>,
    methodName: string
  ): Promise<void> {
    total++;
    try {
      const result = await fn();
      // Method returned instead of raising — that's the OLD bug
      console.log(`  FAIL  ${methodName}: returned ${typeof result} instead of throwing`);
      failed++;
    } catch (e: any) {
      const errMsg = e?.message ?? String(e);
      // Check for JSON parse errors (the old bug)
      if (
        errMsg.includes("Unexpected token") ||
        errMsg.includes("is not valid JSON") ||
        (errMsg.includes("JSON") && errMsg.includes("parse"))
      ) {
        console.log(`  FAIL  ${methodName}: got JSON parse error (old bug!) - ${errMsg}`);
        failed++;
      } else if (errMsg.includes("504") || errMsg.includes("status")) {
        console.log(`  PASS  ${methodName}: raised error with status info: ${errMsg.slice(0, 120)}`);
        passed++;
      } else {
        // Some other exception — acceptable as long as it's not a JSON parse error
        console.log(`  PASS  ${methodName}: raised ${e.constructor?.name ?? "Error"}: ${errMsg.slice(0, 120)}`);
        passed++;
      }
    }
  }

  // --- Process methods ---
  console.log("Testing process methods against 504 HTML response:");
  await assertRaisesCleanError(() => sandbox.process.get("test-proc"), "process.get()");
  await assertRaisesCleanError(() => sandbox.process.list(), "process.list()");
  await assertRaisesCleanError(() => sandbox.process.stop("test-proc"), "process.stop()");
  await assertRaisesCleanError(() => sandbox.process.kill("test-proc"), "process.kill()");
  await assertRaisesCleanError(() => sandbox.process.logs("test-proc"), "process.logs()");

  // --- Filesystem methods ---
  console.log("\nTesting filesystem methods against 504 HTML response:");
  await assertRaisesCleanError(() => sandbox.fs.ls("/"), "fs.ls()");
  await assertRaisesCleanError(() => sandbox.fs.read("/test.txt"), "fs.read()");
  await assertRaisesCleanError(() => sandbox.fs.mkdir("/testdir"), "fs.mkdir()");
  await assertRaisesCleanError(() => sandbox.fs.write("/test.txt", "hello"), "fs.write()");
  await assertRaisesCleanError(() => sandbox.fs.rm("/test.txt"), "fs.rm()");
  await assertRaisesCleanError(() => sandbox.fs.find("/"), "fs.find()");
  await assertRaisesCleanError(() => sandbox.fs.grep("test", "/"), "fs.grep()");

  // --- Streaming exec ---
  console.log("\nTesting streaming exec against 504 HTML response:");
  await assertRaisesCleanError(
    () =>
      sandbox.process.exec({
        command: "echo hello",
        waitForCompletion: true,
        onLog: (_log: string) => {},
      }),
    "process.exec(streaming)"
  );

  console.log(`\n--- 504 Error Handling Results: ${passed}/${total} passed, ${failed} failed ---`);

  server.close();
  return { passed, failed };
}

// ============================================================
// Part 2: Real dev sandbox tests
// ============================================================

async function testRealSandbox(): Promise<{ passed: number; failed: number }> {
  console.log(`\n${"=".repeat(60)}`);
  console.log("PART 2: Testing normal operations on real dev sandbox");
  console.log(`${"=".repeat(60)}\n`);

  let passed = 0;
  let failed = 0;
  let total = 0;
  let sandbox: SandboxInstance | null = null;
  const sandboxName = "reproducer-504-ts-test";

  try {
    // Create sandbox
    console.log(`Creating sandbox '${sandboxName}'...`);
    sandbox = await SandboxInstance.create({ name: sandboxName });
    console.log(`  Sandbox created: ${sandboxName}`);

    // Test 1: process.exec() with wait
    total++;
    try {
      const result = await sandbox.process.exec({
        command: "echo 'Hello from TS reproducer'",
        waitForCompletion: true,
      });
      if (result.status === "completed" && result.exitCode === 0) {
        console.log(`  PASS  process.exec() with wait - status=${result.status}, exit_code=${result.exitCode}`);
        passed++;
      } else {
        console.log(`  FAIL  process.exec() with wait - unexpected: status=${result.status}, exit_code=${result.exitCode}`);
        failed++;
      }
    } catch (e: any) {
      console.log(`  FAIL  process.exec() with wait: ${e.message}`);
      failed++;
    }

    // Test 2: process.get()
    total++;
    try {
      const procs = await sandbox.process.list();
      if (Array.isArray(procs) && procs.length > 0) {
        const proc = await sandbox.process.get(procs[0].name!);
        console.log(`  PASS  process.get() - name=${proc.name}, status=${proc.status}`);
        passed++;
      } else {
        console.log(`  FAIL  process.get() - no processes found to get`);
        failed++;
      }
    } catch (e: any) {
      console.log(`  FAIL  process.get(): ${e.message}`);
      failed++;
    }

    // Test 3: process.list()
    total++;
    try {
      const procs = await sandbox.process.list();
      if (Array.isArray(procs)) {
        console.log(`  PASS  process.list() - found ${procs.length} processes`);
        passed++;
      } else {
        console.log(`  FAIL  process.list() - returned ${typeof procs}`);
        failed++;
      }
    } catch (e: any) {
      console.log(`  FAIL  process.list(): ${e.message}`);
      failed++;
    }

    // Test 4: process.logs()
    total++;
    try {
      const procs = await sandbox.process.list();
      if (Array.isArray(procs) && procs.length > 0) {
        const logs = await sandbox.process.logs(procs[0].name!);
        console.log(`  PASS  process.logs() - got ${logs.length} chars of logs`);
        passed++;
      } else {
        console.log(`  FAIL  process.logs() - no processes to get logs from`);
        failed++;
      }
    } catch (e: any) {
      console.log(`  FAIL  process.logs(): ${e.message}`);
      failed++;
    }

    // Test 5: fs.ls()
    total++;
    try {
      const dir = await sandbox.fs.ls("/");
      console.log(`  PASS  fs.ls() - returned ${typeof dir}`);
      passed++;
    } catch (e: any) {
      console.log(`  FAIL  fs.ls(): ${e.message}`);
      failed++;
    }

    // Test 6: fs.write() + fs.read() round-trip
    total++;
    try {
      await sandbox.fs.write("/tmp/test-reproducer.txt", "hello from TS reproducer");
      const content = await sandbox.fs.read("/tmp/test-reproducer.txt");
      if (content.includes("hello from TS reproducer")) {
        console.log(`  PASS  fs.write() + fs.read() - round-trip OK`);
        passed++;
      } else {
        console.log(`  FAIL  fs.write() + fs.read() - content mismatch: ${content}`);
        failed++;
      }
    } catch (e: any) {
      console.log(`  FAIL  fs.write() + fs.read(): ${e.message}`);
      failed++;
    }

    // Test 7: process.exec() with non-zero exit
    total++;
    try {
      const result = await sandbox.process.exec({
        command: "exit 42",
        waitForCompletion: true,
      });
      if (result.exitCode === 42) {
        console.log(`  PASS  process.exec() non-zero exit - exit_code=${result.exitCode}`);
        passed++;
      } else {
        console.log(`  FAIL  process.exec() non-zero exit - exit_code=${result.exitCode}`);
        failed++;
      }
    } catch (e: any) {
      console.log(`  FAIL  process.exec() non-zero exit: ${e.message}`);
      failed++;
    }

    // Test 8: process.get(nonexistent) should throw clean error, NOT JSON parse error
    total++;
    try {
      await sandbox.process.get("nonexistent-process-xyz");
      console.log(`  FAIL  process.get(nonexistent): did not throw`);
      failed++;
    } catch (e: any) {
      const errMsg = e?.message ?? String(e);
      if (
        errMsg.includes("Unexpected token") ||
        errMsg.includes("is not valid JSON") ||
        (errMsg.includes("JSON") && errMsg.includes("parse"))
      ) {
        console.log(`  FAIL  process.get(nonexistent): got JSON parse error (old bug!) - ${errMsg}`);
        failed++;
      } else {
        console.log(`  PASS  process.get(nonexistent): raised error: ${errMsg.slice(0, 100)}`);
        passed++;
      }
    }
  } catch (e: any) {
    console.log(`\n  ERROR during sandbox tests: ${e.message}`);
  } finally {
    // Cleanup
    if (sandbox) {
      console.log(`\nCleaning up sandbox '${sandboxName}'...`);
      try {
        await SandboxInstance.delete(sandboxName);
        console.log(`  Sandbox deleted.`);
      } catch (e: any) {
        console.log(`  Warning: could not delete sandbox: ${e.message}`);
      }
    }
  }

  console.log(`\n--- Real Sandbox Results: ${passed}/${total} passed, ${failed} failed ---`);
  return { passed, failed };
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log("=".repeat(60));
  console.log("Blaxel TypeScript SDK 504 Error Handling Reproducer");
  console.log("=".repeat(60));

  const part1 = await testMock504ErrorHandling();
  const part2 = await testRealSandbox();

  const totalPassed = part1.passed + part2.passed;
  const totalFailed = part1.failed + part2.failed;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`FINAL SUMMARY: ${totalPassed}/${totalPassed + totalFailed} passed, ${totalFailed} failed`);
  console.log(`  Part 1 (504 mock): ${part1.passed}/${part1.passed + part1.failed}`);
  console.log(`  Part 2 (real sandbox): ${part2.passed}/${part2.passed + part2.failed}`);
  console.log("=".repeat(60));

  if (totalFailed > 0) {
    console.log("\nSOME TESTS FAILED - the fix may have issues.");
    process.exit(1);
  } else {
    console.log("\nALL TESTS PASSED - the fix is working correctly.");
    process.exit(0);
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(2);
});
