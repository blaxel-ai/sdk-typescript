// Shared WebSocket functionality test for all runtime environments
// This module tests the getWebSocket() function across different environments

export async function testWebSocketFunctionality(environmentName) {
  console.log(`🔌 Testing WebSocket functionality in ${environmentName}...`);

  try {
    // Test 1: Import the getWebSocket function
    let getWebSocket;
    try {
      if (typeof require !== 'undefined') {
        // CommonJS environment
        const { getWebSocket: wsFunc } = require("@blaxel/core");
        getWebSocket = wsFunc;
      } else {
        // ESM environment
        const { getWebSocket: wsFunc } = await import("@blaxel/core");
        getWebSocket = wsFunc;
      }
      console.log("✅ getWebSocket function imported successfully");
    } catch (error) {
      console.error("❌ Failed to import getWebSocket:", error.message);
      return false;
    }

    // Test 2: Check if getWebSocket is a function
    if (typeof getWebSocket !== 'function') {
      console.error("❌ getWebSocket is not a function:", typeof getWebSocket);
      return false;
    }
    console.log("✅ getWebSocket is a function");

    // Test 3: Call getWebSocket and check the result
    let WebSocketConstructor;
    try {
      WebSocketConstructor = await getWebSocket();
      console.log("✅ getWebSocket() call successful");
    } catch (error) {
      console.error("❌ getWebSocket() failed:", error.message);
      return false;
    }

    // Test 4: Verify the WebSocket constructor
    if (!WebSocketConstructor) {
      console.error("❌ getWebSocket() returned null/undefined");
      return false;
    }

    if (typeof WebSocketConstructor !== 'function') {
      console.error("❌ WebSocket constructor is not a function:", typeof WebSocketConstructor);
      return false;
    }
    console.log("✅ WebSocket constructor is valid");

    // Test 5: Check WebSocket constructor properties
    const isBrowser = typeof window !== 'undefined';
    if (isBrowser) {
      // In browser, should return native WebSocket
      if (WebSocketConstructor !== WebSocket) {
        console.error("❌ Browser WebSocket constructor mismatch");
        return false;
      }
      console.log("✅ Browser: Native WebSocket constructor returned");
    } else {
      // In Node.js, should return 'ws' package WebSocket
      if (!WebSocketConstructor.name || WebSocketConstructor.name !== 'WebSocket') {
        console.error("❌ Node.js: Invalid WebSocket constructor name:", WebSocketConstructor.name);
        return false;
      }
      console.log("✅ Node.js: 'ws' package WebSocket constructor returned");
    }

    // Test 6: Test WebSocket instantiation (without actually connecting)
    try {
      const wsUrl = isBrowser ? 'ws://localhost:8080' : 'ws://echo.websocket.org';
      const testSocket = new WebSocketConstructor(wsUrl);

      // Immediately close to avoid connection
      if (typeof testSocket.close === 'function') {
        testSocket.close();
      }
      console.log("✅ WebSocket instantiation successful");
    } catch (error) {
      // This might fail in some environments due to network restrictions, but that's OK
      // as long as the constructor exists and can be called
      console.log("⚠️ WebSocket instantiation test:", error.message);
    }

    // Test 7: Test multiple calls to getWebSocket (caching behavior)
    const WebSocketConstructor2 = await getWebSocket();
    if (WebSocketConstructor !== WebSocketConstructor2) {
      console.error("❌ getWebSocket() caching failed - returned different instances");
      return false;
    }
    console.log("✅ getWebSocket() caching works correctly");

    console.log(`🎉 All WebSocket tests passed in ${environmentName}!`);
    return true;

  } catch (error) {
    console.error(`❌ WebSocket test failed in ${environmentName}:`, error.message);
    console.error("Stack trace:", error.stack);
    return false;
  }
}

// For CommonJS environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { testWebSocketFunctionality };
}
