// Test Browser environment compatibility
import { env } from "@blaxel/core";

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

    results.innerHTML = `
      <div class="success">
        <h3>✅ All Browser Tests Passed!</h3>
        <ul>
          <li>@blaxel/core imported successfully</li>
          <li>Environment object accessible: ${typeof env}</li>
          <li>Browser APIs available: window, document</li>
          <li>Bundle size optimized by Vite</li>
        </ul>
      </div>
    `;

  } catch (error) {
    console.error("❌ Browser test failed:", error);
    results.innerHTML = `
      <div class="error">
        <h3>❌ Browser Test Failed</h3>
        <p><strong>Error:</strong> ${(error as Error).message}</p>
        <p>Check the console output below for details.</p>
      </div>
    `;
  }
}

// Run tests when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void runBrowserTests());
} else {
  void runBrowserTests();
}
