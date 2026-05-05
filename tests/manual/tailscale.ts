import { SandboxInstance } from "@blaxel/core";

const TS_AUTHKEY = process.env.TS_AUTHKEY!; // Tailscale auth key
const SANDBOX_NAME = "tailscale-sandbox";

// 1. Create sandbox with iptables enabled
const sandbox = await SandboxInstance.create({
  name: SANDBOX_NAME,
  extraArgs: { iptables: "enabled" },
});

// 2. Install dependencies
await sandbox.process.exec({
  name: "install-deps",
  command: "apk add --no-cache tailscale iptables",
  waitForCompletion: true,
  timeout: 60000,
});

// 3. Start the tailscaled daemon in the background
await sandbox.process.exec({
  name: "tailscaled",
  command: "tailscaled",
  keepAlive: true,
  timeout: 0, // run indefinitely
});

// Give the daemon a moment to initialize
await new Promise((r) => setTimeout(r, 2000));

// 4. Authenticate and bring up the interface
const up = await sandbox.process.exec({
  name: "tailscale-up",
  command: `tailscale up --authkey=${TS_AUTHKEY} --hostname=${SANDBOX_NAME} --ssh`,
  waitForCompletion: true,
  timeout: 30000,
});
console.log("tailscale up:", up.logs);

// 5. Get the Tailscale IP
const ip = await sandbox.process.exec({
  name: "tailscale-ip",
  command: "tailscale ip",
  waitForCompletion: true,
  timeout: 10000,
});
console.log("Tailscale IP:", ip.logs?.trim());
