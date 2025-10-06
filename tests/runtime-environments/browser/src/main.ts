// Test Browser environment compatibility
import { env, getWebSocket } from "@blaxel/core";

const results = document.getElementById('results')!;
const consoleOutput = document.getElementById('console-output')!;

// Capture console output
const originalLog = console.log;
const originalError = console.error;
const logs: string[] = [];

console.log = (...args) => {
  logs.push(`[LOG] ${args.join(' ')}`);
  consoleOutput.textContent = logs.join('\n');
  originalLog(...args);
};

console.error = (...args) => {
  logs.push(`[ERROR] ${args.join(' ')}`);
  consoleOutput.textContent = logs.join('\n');
  originalError(...args);
};

async function runBrowserTests() {
  try {
    console.log("🧪 Testing Browser environment...");

    // Test @blaxel/core imports
    console.log("✅ @blaxel/core env:", typeof env);

    // Test browser-specific features
    console.log("✅ Window object:", typeof window);
    console.log("✅ Document object:", typeof document);

    // Test that we can access the env object
    const envKeys = Object.keys(env || {});
    console.log("✅ Environment keys available:", envKeys.length);

    // Test WebSocket functionality in browser
    console.log("🔌 Testing WebSocket functionality in Browser...");
    let wsTestPassed = false;
    try {
      const WebSocketConstructor = await getWebSocket();
      console.log("✅ getWebSocket() successful:", typeof WebSocketConstructor);

      if (WebSocketConstructor === WebSocket) {
        console.log("✅ Browser WebSocket constructor returned");
        wsTestPassed = true;
      } else {
        console.log("❌ Browser WebSocket constructor mismatch");
      }
    } catch (error) {
      console.error("❌ Browser WebSocket test failed:", (error as Error).message);
    }

    results.innerHTML = `
      <div class="${wsTestPassed ? 'success' : 'error'}">
        <h3>${wsTestPassed ? '✅ All Browser Tests Passed!' : '⚠️ Browser Tests Completed with Issues'}</h3>
        <ul>
          <li>@blaxel/core imported successfully</li>
          <li>Environment object accessible: ${typeof env}</li>
          <li>Browser APIs available: window, document</li>
          <li>WebSocket functionality: ${wsTestPassed ? '✅ PASSED' : '❌ FAILED'}</li>
          <li>Bundle size optimized by Vite</li>
        </ul>
      </div>
    `;

    if (!wsTestPassed) {
      throw new Error("WebSocket functionality test failed in browser");
    }

  } catch (error) {
    console.error("❌ Browser test failed:", error);
    results.innerHTML = `
      <div class="error">
        <h3>❌ Browser Test Failed</h3>
        <p><strong>Error:</strong> ${(error as Error).message}</p>
        <p>Check the console output below for details.</p>
      </div>
    `;
    throw error;
  }
}

// Run tests when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void runBrowserTests());
} else {
  void runBrowserTests();
}
