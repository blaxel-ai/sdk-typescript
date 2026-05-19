import { CodeInterpreter, SandboxInstance } from "../../@blaxel/core/dist/esm/index.js";
import { h2Pool } from "../../@blaxel/core/dist/esm/common/h2pool.js";

const originalDisableH2 = process.env.BL_DISABLE_H2;
const region = process.env.BL_REGION || "us-was-1";
const image = process.env.H2_MATRIX_IMAGE || "blaxel/base-image:latest";
const labels = {
  env: "manual-reliability",
  issue: "eng-2547",
  "created-by": "codex",
};
const modes = [
  { name: "h2-on", disableH2: false },
  { name: "h2-off", disableH2: true },
];

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

function assertStatus(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function deleteByName(klass, name) {
  try {
    await klass.delete(name);
  } catch {
    // Best-effort cleanup for resources that may not have been created.
  }
}

async function runProcessStreamingProbe(sandbox, mode) {
  let streamed = "";
  const result = await withTimeout(`${mode.name}:process-stream`, 60_000, () =>
    sandbox.process.exec({
      command: "node -e \"setTimeout(() => console.log('h2-matrix-process-ok'), 500)\"",
      waitForCompletion: true,
      timeout: 30,
      onStdout: (line) => {
        streamed += line;
      },
    }),
  );

  assertStatus(result.exitCode === 0, `${mode.name}: process exit ${result.exitCode}`);
  assertStatus(
    `${streamed}${result.stdout || ""}`.includes("h2-matrix-process-ok"),
    `${mode.name}: process stdout marker missing`,
  );
  log("process-stream:ok", { mode: mode.name, exitCode: result.exitCode });
}

async function runPortFetchProbe(sandbox, mode) {
  await withTimeout(`${mode.name}:wait-for-port`, 90_000, () =>
    sandbox.process.exec({
      name: `h2-matrix-server-${mode.name}`,
      command: "python3 -m http.server 3000 --bind 0.0.0.0",
      waitForPorts: [3000],
      keepAlive: true,
      timeout: 120,
    }),
  );

  const response = await withTimeout(`${mode.name}:port-fetch`, 30_000, () =>
    sandbox.fetch(3000),
  );
  const body = await response.text();
  assertStatus(response.status === 200, `${mode.name}: port fetch status ${response.status}`);
  assertStatus(body.length > 0, `${mode.name}: port fetch body missing`);
  log("port-fetch:ok", { mode: mode.name, status: response.status, bytes: body.length });
}

async function runFilesystemProbe(sandbox, mode) {
  const size = 6 * 1024 * 1024;
  const content = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    content[i] = i % 251;
  }

  const path = `/tmp/h2-matrix-${mode.name}.bin`;
  await withTimeout(`${mode.name}:filesystem-write`, 90_000, () =>
    sandbox.fs.writeBinary(path, content),
  );
  const blob = await withTimeout(`${mode.name}:filesystem-read`, 60_000, () =>
    sandbox.fs.readBinary(path),
  );
  const result = new Uint8Array(await blob.arrayBuffer());

  assertStatus(result.length === size, `${mode.name}: binary length ${result.length}`);
  assertStatus(result[0] === 0, `${mode.name}: first byte mismatch`);
  assertStatus(result[251] === 0, `${mode.name}: middle byte mismatch`);
  assertStatus(result[size - 1] === (size - 1) % 251, `${mode.name}: last byte mismatch`);
  log("filesystem-binary:ok", { mode: mode.name, bytes: result.length });
}

async function runInterpreterProbe(mode) {
  const name = `h2-matrix-interpreter-${mode.name}-${Date.now()}`;
  let interpreter;

  try {
    log("interpreter:create:start", { mode: mode.name, name, region });
    interpreter = await withTimeout(`${mode.name}:interpreter-create`, 180_000, () =>
      CodeInterpreter.create({
        name,
        region,
        memory: 2048,
        labels,
      }),
    );
    log("interpreter:create:ok", { mode: mode.name, name });

    const execution = await withTimeout(`${mode.name}:interpreter-run`, 90_000, () =>
      interpreter.runCode("print('h2-matrix-interpreter-ok')", { timeout: 60 }),
    );
    const stdout = execution.logs.stdout.join("");
    assertStatus(
      stdout.includes("h2-matrix-interpreter-ok"),
      `${mode.name}: interpreter stdout marker missing`,
    );
    log("interpreter-run:ok", { mode: mode.name, stdout });
  } finally {
    log("interpreter:cleanup:start", { mode: mode.name, name });
    if (interpreter) {
      await interpreter.delete().catch(() => {});
    }
    await deleteByName(CodeInterpreter, name);
    log("interpreter:cleanup:done", { mode: mode.name, name });
  }
}

async function runMode(mode) {
  const name = `h2-matrix-${mode.name}-${Date.now()}`;
  let sandbox;
  setH2Mode(mode);

  try {
    log("sandbox:create:start", { mode: mode.name, name, region, image });
    sandbox = await withTimeout(`${mode.name}:sandbox-create`, 180_000, () =>
      SandboxInstance.create({
        name,
        image,
        region,
        memory: 4096,
        ports: [{ name: "http", target: 3000, protocol: "HTTP" }],
        labels,
      }),
    );
    log("sandbox:create:ok", { mode: mode.name, name, status: sandbox.status });

    await runProcessStreamingProbe(sandbox, mode);
    await runPortFetchProbe(sandbox, mode);
    await runFilesystemProbe(sandbox, mode);
    await runInterpreterProbe(mode);

    return { mode: mode.name, ok: true };
  } catch (error) {
    log("mode:error", {
      mode: mode.name,
      name,
      error: error instanceof Error ? error.message : String(error),
    });
    return { mode: mode.name, ok: false };
  } finally {
    log("sandbox:cleanup:start", { mode: mode.name, name });
    if (sandbox) {
      await sandbox.delete().catch(() => {});
    }
    await deleteByName(SandboxInstance, name);
    h2Pool.closeAll();
    log("sandbox:cleanup:done", { mode: mode.name, name });
  }
}

try {
  assertEnv();
  const results = [];
  for (const mode of modes) {
    results.push(await runMode(mode));
  }

  log("summary", { results });
  if (results.some((result) => !result.ok)) {
    process.exitCode = 1;
  }
} finally {
  restoreH2Mode();
}
