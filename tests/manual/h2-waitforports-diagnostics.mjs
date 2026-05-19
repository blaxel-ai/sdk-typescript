import { SandboxInstance } from "../../@blaxel/core/dist/esm/index.js";
import { h2Pool } from "../../@blaxel/core/dist/esm/common/h2pool.js";

const originalDisableH2 = process.env.BL_DISABLE_H2;
const count = Number.parseInt(process.env.SANDBOX_COUNT || "5", 10);
const region = process.env.BL_REGION || "us-was-1";
const labels = {
  env: "manual-reliability",
  issue: "eng-2547-waitforports",
  "created-by": "codex",
};
const modes = [
  { name: "h2-on", disableH2: false },
  { name: "h2-off", disableH2: true },
];

const nodeServerCommand = `sleep 2 && node -e "
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});
server.listen(3000);
"`;

const pythonServerCommand = `sleep 2 && python3 -c "
from http.server import HTTPServer, BaseHTTPRequestHandler

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain')
        self.end_headers()
        self.wfile.write(b'OK')
    def log_message(self, *args):
        pass

HTTPServer(('', 3000), H).serve_forever()
"`;

function log(phase, details = {}) {
  console.log(JSON.stringify({ phase, ...details }));
}

function assertEnv() {
  const missing = ["BL_API_KEY", "BL_WORKSPACE"].filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

function setH2Mode(mode) {
  h2Pool.closeAll();
  if (mode.disableH2) {
    process.env.BL_DISABLE_H2 = "true";
  } else {
    delete process.env.BL_DISABLE_H2;
  }
}

function restoreH2Mode() {
  h2Pool.closeAll();
  if (originalDisableH2 === undefined) {
    delete process.env.BL_DISABLE_H2;
  } else {
    process.env.BL_DISABLE_H2 = originalDisableH2;
  }
}

async function withTimeout(label, ms, fn) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });

  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function cleanupSandbox(sandbox, name) {
  if (sandbox) {
    await sandbox.delete().catch(() => {});
  }
  await SandboxInstance.delete(name).catch(() => {});
}

function getProbeSpec(mode, index) {
  const runtime = index % 2 === 0 ? "node" : "python";
  const image = runtime === "node" ? "blaxel/node:latest" : "blaxel/py-app:latest";
  const name = `h2-wfp-${mode.name}-${runtime}-${index}-${Date.now()}`;
  return { index, name, runtime, image };
}

async function createProbeSandbox(mode, spec) {
  try {
    const instance = await withTimeout(`${mode.name}:${spec.name}:create`, 180_000, () =>
      SandboxInstance.create({
        name: spec.name,
        image: spec.image,
        region,
        memory: 2048,
        ports: [{ target: 3000, protocol: "HTTP" }],
        labels,
      }),
    );

    return { ...spec, instance, createError: null };
  } catch (error) {
    const createError = error instanceof Error ? error.message : String(error);
    log("probe:create:error", {
      mode: mode.name,
      index: spec.index,
      name: spec.name,
      runtime: spec.runtime,
      error: createError,
    });
    return { ...spec, instance: null, createError };
  }
}

async function runProbe(mode, sandboxRecord) {
  const { index, name, instance, runtime } = sandboxRecord;
  const command = runtime === "node" ? nodeServerCommand : pythonServerCommand;
  const result = {
    mode: mode.name,
    index,
    name,
    runtime,
    execStatus: null,
    fetchStatus: null,
    body: null,
    error: null,
  };

  try {
    const execResult = await withTimeout(`${mode.name}:${name}:waitForPorts`, 120_000, () =>
      instance.process.exec({
        name: `server-${index}`,
        command,
        waitForPorts: [3000],
      }),
    );
    result.execStatus = execResult.status || "started";

    const response = await withTimeout(`${mode.name}:${name}:fetch`, 30_000, () =>
      instance.fetch(3000),
    );
    result.fetchStatus = response.status;
    result.body = await response.text();
    if (response.status !== 200 || result.body !== "OK") {
      throw new Error(`fetch returned ${response.status}: ${result.body}`);
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  log("probe:result", result);
  return result;
}

async function runMode(mode) {
  setH2Mode(mode);
  const sandboxes = [];

  try {
    log("mode:create:start", { mode: mode.name, count, region });
    const specs = Array.from({ length: count }, (_, index) => getProbeSpec(mode, index));
    const created = await Promise.all(
      specs.map((spec) => createProbeSandbox(mode, spec)),
    );
    sandboxes.push(...created);
    const createFailures = sandboxes
      .filter((sandboxRecord) => sandboxRecord.createError)
      .map((sandboxRecord) => ({
        mode: mode.name,
        index: sandboxRecord.index,
        name: sandboxRecord.name,
        runtime: sandboxRecord.runtime,
        execStatus: null,
        fetchStatus: null,
        body: null,
        error: sandboxRecord.createError,
      }));
    const runnableSandboxes = sandboxes.filter((sandboxRecord) => sandboxRecord.instance);
    log("mode:create:done", {
      mode: mode.name,
      count: sandboxes.length,
      successes: runnableSandboxes.length,
      failures: createFailures.length,
    });

    const results = await Promise.all(
      runnableSandboxes.map((sandboxRecord) => runProbe(mode, sandboxRecord)),
    );
    const allResults = [...createFailures, ...results];
    const failures = allResults.filter((result) => result.error);
    log("mode:summary", {
      mode: mode.name,
      successes: allResults.length - failures.length,
      failures: failures.length,
      results: allResults,
    });

    return { mode: mode.name, results: allResults, failures };
  } finally {
    log("mode:cleanup:start", { mode: mode.name, count: sandboxes.length });
    await Promise.allSettled(
      sandboxes.map(({ instance, name }) => cleanupSandbox(instance, name)),
    );
    h2Pool.closeAll();
    log("mode:cleanup:done", { mode: mode.name, count: sandboxes.length });
  }
}

try {
  assertEnv();
  const summaries = [];
  for (const mode of modes) {
    summaries.push(await runMode(mode));
  }

  log("summary", {
    summaries: summaries.map((summary) => ({
      mode: summary.mode,
      successes: summary.results.length - summary.failures.length,
      failures: summary.failures.length,
    })),
  });

  if (summaries.some((summary) => summary.failures.length > 0)) {
    process.exitCode = 1;
  }
} finally {
  restoreH2Mode();
}
