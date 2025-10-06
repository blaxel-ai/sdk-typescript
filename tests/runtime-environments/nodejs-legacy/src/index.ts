// Test legacy Node module resolution
import { env, getTool, getWebSocket, ToolOptions } from "@blaxel/core";
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

async function testWebSocket() {
  console.log("🔌 Testing WebSocket functionality...");

  try {
    const WebSocketConstructor = await getWebSocket();
    console.log("✅ getWebSocket() successful:", typeof WebSocketConstructor);

    if (typeof WebSocketConstructor === 'function') {
      console.log("✅ WebSocket constructor valid:", WebSocketConstructor.name);

      // Test caching
      const WebSocketConstructor2 = await getWebSocket();
      if (WebSocketConstructor === WebSocketConstructor2) {
        console.log("✅ WebSocket caching works correctly");
      } else {
        console.log("⚠️ WebSocket caching issue detected");
      }
    } else {
      console.log("❌ WebSocket constructor invalid");
      return false;
    }
  } catch (error) {
    console.log("❌ WebSocket test failed:", (error as Error).message);
    return false;
  }

  return true;
}

async function main() {
  console.log("🧪 Testing legacy Node module resolution...");
  await testCore();

  const wsTestPassed = await testWebSocket();

  console.log("✅ All imports successful with moduleResolution: node");

  if (wsTestPassed) {
    console.log("✅ WebSocket functionality verified");
  } else {
    console.log("❌ WebSocket functionality failed");
    process.exit(1);
  }
}

main().catch(console.error);
