import { SandboxInstance } from "../../@blaxel/core/dist/esm/index.js";

const name = `pm2160-h2-unref-${Date.now()}`;
const region = process.env.BL_REGION || "us-was-1";
const labels = {
  env: "manual-repro",
  issue: "pm-2160",
  "created-by": "codex",
};

let sandbox;

async function cleanup() {
  if (!sandbox) return;
  console.log(JSON.stringify({ phase: "cleanup:start", name }));
  await sandbox.delete();
  console.log(JSON.stringify({ phase: "cleanup:done", name }));
}

async function main() {
  console.log(JSON.stringify({ phase: "create:start", name, region }));
  sandbox = await SandboxInstance.create({
    name,
    image: "blaxel/base-image:latest",
    memory: 4096,
    region,
    labels,
  });
  console.log(JSON.stringify({ phase: "create:done", name, status: sandbox.status }));

  console.log(JSON.stringify({ phase: "exec:start", name }));
  const result = await sandbox.process.exec({
    command: "node -e \"setTimeout(() => console.log('pm2160-ok'), 1500)\"",
    waitForCompletion: true,
  });
  console.log(JSON.stringify({
    phase: "exec:done",
    name,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  }));
}

try {
  await main();
} finally {
  await cleanup();
}
