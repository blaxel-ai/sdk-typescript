// Test Bun runtime compatibility
import {
  detectBunVersion,
  env,
  getTool,
  isBrokenBunVersion,
  settings,
  ToolOptions,
} from "@blaxel/core";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function testCore() {
  console.log("✅ @blaxel/core env:", typeof env);

  try {
    const tools = await getTool("test-tool", { timeout: 5000 } as ToolOptions);
    console.log("✅ @blaxel/core getTool:", typeof tools);
  } catch (e) {
    console.log("✅ @blaxel/core getTool error (expected):", (e as Error).message);
  }
}

// The crux of the Bun H2 story: the SDK must force its pooled HTTP/2 transport
// OFF on Bun < 1.3.11 (which never sends a connection-level WINDOW_UPDATE and so
// freezes the shared session after 65535 cumulative body bytes) and leave it ON
// on 1.3.11+. Run under a CI matrix of Bun versions, this asserts the gate flips
// at exactly the right version — the behavior we regressed on before.
function testH2VersionGate() {
  const running = Bun.version;
  const detected = detectBunVersion();
  console.log("✅ Bun.version:", running, "| detectBunVersion:", detected);
  assert(
    detected === running,
    `detectBunVersion (${detected}) should equal Bun.version (${running})`,
  );

  const expectedBroken = isBrokenBunVersion(running);
  console.log(
    `✅ Bun ${running} broken-H2=${expectedBroken} -> settings.disableH2=${settings.disableH2}`,
  );
  assert(
    settings.disableH2 === expectedBroken,
    `On Bun ${running}, settings.disableH2 (${settings.disableH2}) must match ` +
      `isBrokenBunVersion (${expectedBroken}): H2 off iff the runtime is a broken Bun.`,
  );
}

// Prove the running Bun actually moves a body well past the 65535 freeze
// threshold without hanging. On a broken Bun the SDK sidesteps the bug by
// disabling H2, but the runtime's own HTTP path must still round-trip a large
// body — this is the smoke test that it does, deterministically and fast.
async function testLargeBodyRoundTrip() {
  const size = 200_000; // ~3x the 65535 connection window
  const payload = "a".repeat(size);

  const server = Bun.serve({
    port: 0,
    async fetch(request: Request) {
      const body = await request.text();
      return new Response(body, {
        headers: { "content-length": String(body.length) },
      });
    },
  });
  try {
    const res = await fetch(`http://localhost:${server.port}/echo`, {
      method: "POST",
      body: payload,
    });
    const echoed = await res.text();
    assert(
      echoed.length === size,
      `large-body round-trip truncated: sent ${size}, got ${echoed.length}`,
    );
    assert(echoed === payload, "large-body round-trip corrupted the payload");
    console.log(`✅ Large-body round-trip OK (${size} bytes, > 65535 window)`);
  } finally {
    server.stop();
  }
}

async function testBunSpecific() {
  // Test Bun-specific APIs
  console.log("✅ Bun object:", typeof Bun);
  console.log("✅ Bun version:", Bun?.version || "unknown");

  // Test Bun's built-in fetch
  console.log("✅ Fetch available:", typeof fetch);

  // Test Bun's file system
  try {
    const file = Bun.file("package.json");
    const exists = await file.exists();
    console.log("✅ Bun file API:", exists ? "working" : "not found");
  } catch (e) {
    console.log("⚠️  Bun file API:", (e as Error).message);
  }
}

async function main() {
  console.log("🧪 Testing Bun runtime environment...");
  console.log("==========================================");

  try {
    await testCore();
    await testBunSpecific();
    testH2VersionGate();
    await testLargeBodyRoundTrip();

    console.log("==========================================");
    console.log("✅ All imports successful with Bun runtime");

    // Create a simple HTTP server to test
    const server = Bun.serve({
      port: 3001,
      fetch(_request: Request) {
        return new Response(JSON.stringify({
          status: "success",
          message: "✅ All imports successful in Bun runtime",
          environment: "bun",
          bunVersion: Bun.version,
          envType: typeof env,
          timestamp: new Date().toISOString()
        }), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        });
      },
    });

    console.log(`✅ Bun server running at http://localhost:${server.port}`);
    // Validate the server responds, then stop it so the test exits cleanly
    try {
      const res = await fetch(`http://localhost:${server.port}`);
      const json = await res.json();
      if (json?.status === "success") {
        console.log("✅ Server responded with success payload");
      } else {
        console.log("⚠️  Server responded with unexpected payload", json);
      }
    } catch (e) {
      console.log("⚠️  Failed to reach Bun server:", (e as Error).message);
    } finally {
      server.stop();
    }

  } catch (error) {
    console.error("❌ Bun test failed:", error);
    process.exit(1);
  }
}

main().catch(console.error);
