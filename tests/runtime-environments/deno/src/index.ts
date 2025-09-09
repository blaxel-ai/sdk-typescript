// Test Deno runtime compatibility
// @deno-types="npm:@blaxel/core"
import { env, getTool } from "npm:@blaxel/core";

async function testCore() {
  console.log("✅ @blaxel/core env:", typeof env);

  try {
    const tools = await getTool("test-tool", { timeout: 5000 });
    console.log("✅ @blaxel/core getTool:", typeof tools);
  } catch (e) {
    console.log("✅ @blaxel/core getTool error (expected):", (e as Error).message);
  }
}

async function testDenoSpecific() {
  // Test Deno-specific APIs
  console.log("✅ Deno object:", typeof Deno);
  console.log("✅ Deno version:", Deno?.version?.deno || "unknown");

  // Test Deno's built-in fetch
  console.log("✅ Fetch available:", typeof fetch);

  // Test Deno's file system
  try {
    const stat = await Deno.stat("deno.json");
    console.log("✅ Deno file API:", stat ? "working" : "not found");
  } catch (e) {
    console.log("⚠️  Deno file API:", (e as Error).message);
  }
}

async function main() {
  console.log("🧪 Testing Deno runtime environment...");
  console.log("==========================================");

  try {
    await testCore();
    await testDenoSpecific();

    console.log("==========================================");
    console.log("✅ All imports successful with Deno runtime");

  } catch (error) {
    console.error("❌ Deno test failed:", error);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main().catch(console.error);
}
