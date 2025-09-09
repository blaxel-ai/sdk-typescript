// Test plain JavaScript with CommonJS require()
const { env, getTool } = require("@blaxel/core");
require("@blaxel/telemetry");

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
  console.log("🧪 Testing plain JavaScript with require()...");
  await testCore();
  console.log("✅ All imports successful with JavaScript CommonJS require()");
}

main().catch(console.error);
