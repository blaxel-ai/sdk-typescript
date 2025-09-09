// Test plain JavaScript with ESM import
import { env, getTool } from "@blaxel/core";
import "@blaxel/telemetry";

async function testCore() {
  console.log("✅ @blaxel/core env:", typeof env);
  
  try {
    const tools = await getTool("test-tool", { timeout: 5000 });
    console.log("✅ @blaxel/core getTool:", typeof tools);
  } catch (e) {
    console.log("✅ @blaxel/core getTool error (expected):", e.message);
  }
}

async function main() {
  console.log("🧪 Testing plain JavaScript with ESM import...");
  await testCore();
  console.log("✅ All imports successful with JavaScript ESM import");
}

main().catch(console.error);
