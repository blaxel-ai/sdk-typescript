// Test plain JavaScript with ESM import
import { env, getTool, getWebSocket } from "@blaxel/core";
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

async function testWebSocket() {
  console.log("🔌 Testing WebSocket functionality in JavaScript ESM...");

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
    console.log("❌ WebSocket test failed:", error.message);
    return false;
  }

  return true;
}

async function main() {
  console.log("🧪 Testing plain JavaScript with ESM import...");
  await testCore();

  const wsTestPassed = await testWebSocket();

  console.log("✅ All imports successful with JavaScript ESM import");

  if (wsTestPassed) {
    console.log("✅ WebSocket functionality verified in JavaScript ESM");
  } else {
    console.log("❌ WebSocket functionality failed in JavaScript ESM");
    process.exit(1);
  }
}

main().catch(console.error);
