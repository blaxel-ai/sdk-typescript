const { spawn } = require('child_process');
const http = require('http');

async function testCloudflareWorker() {
  console.log("🧪 Testing Cloudflare Workers environment...");

  // Start wrangler dev
  const wrangler = spawn('npx', ['wrangler', 'dev', '--local', '--port', '8787'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false
  });

  let serverReady = false;
  let testResult = null;

  // Wait for server to be ready
  wrangler.stdout.on('data', (data) => {
    const output = data.toString();
    if (output.includes('Ready on')) {
      serverReady = true;
    }
  });

  wrangler.stderr.on('data', (data) => {
    const output = data.toString();
    if (output.includes('Ready on') || output.includes('listening on')) {
      serverReady = true;
    }
  });

  // Wait for server to start (max 30 seconds)
  let attempts = 0;
  while (!serverReady && attempts < 60) {
    await new Promise(resolve => setTimeout(resolve, 500));
    attempts++;
  }

  if (!serverReady) {
    console.error("❌ Wrangler dev failed to start");
    wrangler.kill();
    process.exit(1);
  }

  // Wait a bit more for full startup
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Test the worker
  try {
    const response = await fetch('http://localhost:8787');
    const data = await response.json();

    if (data.status === 'success') {
      console.log("✅ @blaxel/core imports working in Cloudflare Workers");
      console.log("✅ Worker response:", data.message);
      console.log("✅ Environment:", data.environment);
      testResult = true;
    } else {
      console.error("❌ Worker returned error:", data);
      testResult = false;
    }
  } catch (error) {
    console.error("❌ Failed to test worker:", error.message);
    testResult = false;
  }

  // Clean up
  wrangler.kill();

  if (testResult) {
    console.log("✅ All imports successful in Cloudflare Workers");
    process.exit(0);
  } else {
    process.exit(1);
  }
}

testCloudflareWorker().catch((error) => {
  console.error("❌ Test failed:", error);
  process.exit(1);
});
