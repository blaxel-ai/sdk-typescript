// Test Deno runtime compatibility against the local @blaxel/core package.
import { env, SandboxInstance, settings } from "@blaxel/core";

type ProcessResponse = {
  command: string;
  completedAt: string;
  exitCode: number;
  logs: string;
  name: string;
  pid: string;
  startedAt: string;
  status: string;
  stderr: string;
  stdout: string;
  workingDir: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function processResponse(command: string): ProcessResponse {
  const timestamp = new Date().toISOString();
  return {
    command,
    completedAt: timestamp,
    exitCode: 0,
    logs: "ok\n",
    name: "deno-process",
    pid: "deno-process",
    startedAt: timestamp,
    status: "completed",
    stderr: "",
    stdout: "ok\n",
    workingDir: "/",
  };
}

function installFakeSandboxFetch() {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;

  const fakeFetch: typeof fetch = async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.pathname}`);

    if (request.method === "POST" && url.pathname === "/process") {
      const body = await request.json() as { command?: string };
      return json(processResponse(body.command ?? ""));
    }
    if (request.method === "GET" && url.pathname === "/process") {
      return json([processResponse("echo ok")]);
    }
    if (request.method === "PUT" && url.pathname.startsWith("/filesystem/")) {
      return json({ message: "written", path: url.pathname });
    }
    if (request.method === "GET" && url.pathname.startsWith("/filesystem/")) {
      if (url.pathname.includes("deno.txt")) {
        return json({ content: "hello from deno" });
      }
      return json({ files: [], name: "tmp", path: "/tmp", subdirectories: [] });
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/filesystem/")) {
      return json({ message: "deleted", path: url.pathname });
    }
    if (request.method === "GET" && url.pathname === "/drives/mount") {
      return json({ mounts: [] });
    }
    if (request.method === "GET" && url.pathname.startsWith("/codegen/reranking/")) {
      return json({ files: [], message: "ok", success: true });
    }
    if (request.method === "POST" && url.pathname === "/upgrade") {
      return json({ message: "upgrade started" });
    }

    throw new Error(`Unexpected fake sandbox request: ${request.method} ${url.pathname}`);
  };

  globalThis.fetch = fakeFetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function testCoreImports() {
  console.log("✅ @blaxel/core env:", typeof env);
  console.log("✅ @blaxel/core SandboxInstance:", typeof SandboxInstance);
  console.log("✅ @blaxel/core Deno disables H2:", settings.disableH2);
  assert(typeof SandboxInstance === "function", "SandboxInstance import failed");
  assert(settings.disableH2 === true, "Deno runtime should disable SDK H2 by default");
}

async function testSandboxGeneratedActions() {
  const fake = installFakeSandboxFetch();
  try {
    const sandbox = new SandboxInstance({
      metadata: {
        name: "deno-local-sandbox",
        url: "https://sandbox.example.test",
      },
      forceUrl: "https://sandbox.example.test",
      headers: {},
      spec: { region: "us-was-1" },
      status: "DEPLOYED",
    } as never);

    const process = await sandbox.process.exec({ command: "echo ok", waitForCompletion: true });
    assert("stdout" in process && process.stdout === "ok\n", "process.exec did not return stdout");
    assert("exitCode" in process && process.exitCode === 0, "process.exec did not return exit code 0");

    const processes = await sandbox.process.list();
    assert(Array.isArray(processes), "process.list did not return an array");

    await sandbox.fs.write("/tmp/deno.txt", "hello from deno");
    const content = await sandbox.fs.read("/tmp/deno.txt");
    assert(content === "hello from deno", "filesystem read returned unexpected content");

    const directory = await sandbox.fs.ls("/tmp");
    assert(directory.path === "/tmp", "filesystem ls returned unexpected directory");

    const removed = await sandbox.fs.rm("/tmp/deno.txt");
    assert(removed.message === "deleted", "filesystem rm returned unexpected response");

    const mounts = await sandbox.drives.list();
    assert(Array.isArray(mounts), "drives.list did not return an array");

    const rerank = await sandbox.codegen.reranking("/", "deno runtime");
    assert(rerank.success === true, "codegen.reranking returned unexpected response");

    const upgrade = await sandbox.system.upgrade({ version: "latest" });
    assert(upgrade.message === "upgrade started", "system.upgrade returned unexpected response");

    const expectedCalls = [
      "POST /process",
      "GET /process",
      "PUT /filesystem/%2Ftmp%2Fdeno.txt",
      "GET /filesystem/%2Ftmp%2Fdeno.txt",
      "GET /filesystem/%2Ftmp",
      "DELETE /filesystem/%2Ftmp%2Fdeno.txt",
      "GET /drives/mount",
      "GET /codegen/reranking/%2F",
      "POST /upgrade",
    ];
    assert(
      expectedCalls.every((call) => fake.calls.includes(call)),
      `Not all generated sandbox actions were exercised: ${JSON.stringify(fake.calls)}`,
    );
    console.log("✅ Sandbox generated actions work with Deno Request");
  } finally {
    fake.restore();
  }
}

async function testDenoSpecific() {
  console.log("✅ Deno object:", typeof Deno);
  console.log("✅ Deno version:", Deno?.version?.deno || "unknown");
  console.log("✅ Fetch available:", typeof fetch);

  const stat = await Deno.stat("deno.json");
  console.log("✅ Deno file API:", stat ? "working" : "not found");
}

async function main() {
  console.log("🧪 Testing Deno runtime environment...");
  console.log("==========================================");

  testCoreImports();
  await testSandboxGeneratedActions();
  await testDenoSpecific();

  console.log("==========================================");
  console.log("✅ Deno runtime sandbox compatibility checks passed");
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("❌ Deno test failed:", error);
    Deno.exit(1);
  });
}
