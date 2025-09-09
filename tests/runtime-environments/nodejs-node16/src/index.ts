// Test Node16 module resolution
import { env, getTool, ToolOptions } from "@blaxel/core";
import "@blaxel/telemetry";

async function testCore() {
  console.log("✅ @blaxel/core env:", typeof env);

  try {
    const tools = await getTool("test-tool", { timeout: 5000 } as ToolOptions);
    console.log("✅ @blaxel/core getTool:", typeof tools);
  } catch (e) {
    console.log("✅ @blaxel/core getTool error (expected):", (e as Error).message);
  }
}

async function main() {
  console.log("🧪 Testing Node16 module resolution...");
  await testCore();
  console.log("✅ All imports successful with moduleResolution: Node16");
}

main().catch(console.error);
