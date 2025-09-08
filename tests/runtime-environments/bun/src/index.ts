// Test Bun runtime compatibility
import { env, getTool, ToolOptions } from "@blaxel/core";

async function testCore() {
  console.log("✅ @blaxel/core env:", typeof env);

  try {
    const tools = await getTool("test-tool", { timeout: 5000 } as ToolOptions);
    console.log("✅ @blaxel/core getTool:", typeof tools);
  } catch (e) {
    console.log("✅ @blaxel/core getTool error (expected):", (e as Error).message);
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
    console.log("Press Ctrl+C to stop the server");

  } catch (error) {
    console.error("❌ Bun test failed:", error);
    process.exit(1);
  }
}

main().catch(console.error);
