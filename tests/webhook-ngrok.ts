/**
 * Test webhook signature verification with ngrok
 *
 * This script:
 * 1. Starts a local webhook server
 * 2. Exposes it via ngrok
 * 3. Shows you the URL to configure in async-sidecar
 * 4. Asks for your CALLBACK_SECRET
 * 5. Verifies incoming webhooks
 *
 * Usage:
 *   tsx tests/webhook-ngrok.ts
 */

import { verifyWebhookFromRequest } from '@blaxel/core';
import { spawn } from 'child_process';
import express from 'express';
import * as readline from 'readline';

const app = express();
const PORT = 3456;
let CALLBACK_SECRET = '';

// Use text parser to preserve raw body for signature verification
app.use(express.text({ type: 'application/json' }));

// Webhook endpoint
app.post('/webhook', (req, res) => {
  console.log('\n' + '='.repeat(60));
  console.log('📥 Incoming webhook');
  console.log('='.repeat(60));

  const signature = req.headers['x-blaxel-signature'] as string;
  const timestamp = req.headers['x-blaxel-timestamp'] as string;

  console.log('Headers:');
  console.log('  X-Blaxel-Signature:', signature || '❌ MISSING');
  console.log('  X-Blaxel-Timestamp:', timestamp || '❌ MISSING');

  // Verify signature
  const isValid = verifyWebhookFromRequest(req, CALLBACK_SECRET);

  if (!isValid) {
    console.log('\n❌ SIGNATURE VERIFICATION FAILED');
    console.log('   Check that the CALLBACK_SECRET matches on both sides');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  console.log('\n✅ SIGNATURE VERIFIED SUCCESSFULLY');

  // Parse and display the callback data
  try {
    const data = JSON.parse(req.body);
    console.log('\nCallback Data:');
    console.log('  Status Code:', data.status_code);
    console.log('  Response Length:', data.response_length, 'bytes');
    console.log('  Timestamp:', new Date(data.timestamp * 1000).toISOString());
    console.log('  Response Body:');
    console.log('    ' + (data.response_body.length > 200
      ? data.response_body.substring(0, 200) + '...'
      : data.response_body));

    console.log('\n' + '='.repeat(60));

    res.json({ received: true, verified: true });
  } catch (error) {
    console.error('\n❌ Failed to parse callback payload:', error);
    res.status(400).json({ error: 'Invalid payload' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Start the server
const server = app.listen(PORT, () => {
  console.log('🚀 Webhook server started');
  console.log(`   Local: http://localhost:${PORT}/webhook\n`);
  startNgrok();
});

// Start ngrok
function startNgrok() {
  console.log('🌐 Starting ngrok tunnel...');

  const ngrok = spawn('ngrok', ['http', PORT.toString()], {
    stdio: 'ignore'  // Run in background, we'll use the API
  });

  ngrok.on('error', (error) => {
    console.error('❌ Failed to start ngrok:', error.message);
    console.error('\nMake sure ngrok is installed:');
    console.error('  brew install ngrok  (macOS)');
    console.error('  Or download from: https://ngrok.com/download');
    process.exit(1);
  });

  // Give ngrok time to start, then fetch the URL from its API
  console.log('⏳ Waiting for ngrok to start...\n');
  setTimeout(() => fetchNgrokUrl(), 3000);
}

// Fetch ngrok URL from API
async function fetchNgrokUrl(retries = 0) {
  try {
    const response = await fetch('http://localhost:4040/api/tunnels');
    const data = await response.json();

    if (data.tunnels && data.tunnels.length > 0) {
      const tunnel = data.tunnels.find((t: any) => t.proto === 'https') || data.tunnels[0];
      displayInstructions(tunnel.public_url);
    } else if (retries < 3) {
      // Retry if no tunnels found yet
      console.log('⏳ Still waiting for ngrok...');
      setTimeout(() => fetchNgrokUrl(retries + 1), 2000);
    } else {
      console.error('❌ Could not find ngrok tunnel');
      console.error('   Please check that ngrok is running');
      console.error('   You can view ngrok status at: http://localhost:4040');
      process.exit(1);
    }
  } catch (error) {
    if (retries < 3) {
      // Retry on connection error (ngrok might still be starting)
      setTimeout(() => fetchNgrokUrl(retries + 1), 2000);
    } else {
      console.error('❌ Could not connect to ngrok API');
      console.error('   Make sure ngrok is installed and running');
      console.error('   Install with: brew install ngrok');
      console.error('   Or download from: https://ngrok.com/download');
      process.exit(1);
    }
  }
}

function displayInstructions(ngrokUrl: string) {
  console.log('\n' + '='.repeat(60));
  console.log('✅ Ngrok tunnel established!');
  console.log('='.repeat(60));
  console.log('\n📋 Configuration for async-sidecar:');
  console.log('\n  CALLBACK_URL=' + ngrokUrl + '/webhook');
  console.log('\n' + '='.repeat(60));

  askForSecret();
}

function askForSecret() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log('\n🔐 Enter your CALLBACK_SECRET:');
  console.log('   (This should match the CALLBACK_SECRET in async-sidecar)\n');

  rl.question('Secret: ', (answer) => {
    CALLBACK_SECRET = answer.trim();

    if (!CALLBACK_SECRET) {
      console.error('❌ Secret cannot be empty!');
      process.exit(1);
    }

    console.log('\n✅ Secret configured');
    console.log('\n' + '='.repeat(60));
    console.log('🎯 Ready to receive webhooks!');
    console.log('='.repeat(60));
    console.log('\nWaiting for incoming webhooks...');
    console.log('Press Ctrl+C to stop\n');

    rl.close();
  });
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down...');
  server.close();
  process.exit(0);
});

