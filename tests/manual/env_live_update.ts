/**
 * Manual end-to-end test for live environment variable updates (no reboot).
 *
 * A PUT /sandboxes/{name} that changes only spec.runtime.envs on a running
 * mk3.1 sandbox is applied to the live instance through the compute plane
 * (controlplane -> compute-admin -> vmm-manager -> guest -> sandbox-api),
 * without replacing the VM.
 *
 * Flow:
 *   1. Create a sandbox and wait for it to be deployed.
 *   2. Write a marker file with known content.
 *   3. Assert the test variable is absent.
 *   4. Update the sandbox with only an env change (add MY_LIVE_ENV=v1).
 *   5. Poll until a freshly spawned process sees MY_LIVE_ENV=v1.
 *   6. Assert the marker file still exists with the same content — proof the
 *      VM was NOT replaced by the update.
 *   7. Change the value (v1 -> v2) and verify again.
 *   8. Remove the variable and verify it is unset in new processes.
 *   9. Final marker file check, then clean up.
 *
 * This lives under tests/manual because live env updates are only enabled on
 * mk3.1 sandboxes for now, not on every sandbox.
 *
 * Requires: BL_WORKSPACE, BL_API_KEY (and a workspace where sandboxes run on
 * mk3.1 with the compute plane owning them).
 *
 * Run:
 *   cd @blaxel/core && npm run build && cd ../..
 *   npx tsx tests/manual/env_live_update.ts
 */

import { SandboxInstance, updateSandbox, type Sandbox as SandboxModel } from "@blaxel/core"

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const BASE_IMAGE = "blaxel/base-image:latest"
const SANDBOX_NAME = uniqueName("env-live")
const MARKER_PATH = "/app/env-live-update-marker.txt"
const MARKER_CONTENT = `marker-${SANDBOX_NAME}`
const ENV_NAME = "MY_LIVE_ENV"

async function readEnv(sandbox: SandboxInstance, name: string): Promise<string> {
  // Spawn a brand new process: it inherits the sandbox-api process env, which
  // is what the live update refreshes.
  const result = (await sandbox.process.exec({
    command: `sh -c 'printf "%s" "$${name}"'`,
    waitForCompletion: true,
  })) as { logs?: string }
  return result.logs ?? ""
}

async function setEnvs(name: string, envs: { name: string; value: string }[]): Promise<void> {
  // Env-only update: read the current sandbox and PUT it back with only
  // spec.runtime.envs changed.
  const sandbox = await SandboxInstance.get(name)
  const body = {
    ...sandbox.sandbox,
    spec: {
      ...sandbox.spec,
      runtime: { ...sandbox.spec.runtime, envs },
    },
  } as SandboxModel
  await updateSandbox({ path: { sandboxName: name }, body, throwOnError: true })
}

async function waitForEnv(
  sandbox: SandboxInstance,
  expected: string,
  { retries, delayMs }: { retries: number; delayMs: number },
): Promise<void> {
  let last = ""
  for (let i = 0; i < retries; i++) {
    last = await readEnv(sandbox, ENV_NAME)
    if (last === expected) return
    await sleep(delayMs)
  }
  throw new Error(`${ENV_NAME} never became ${JSON.stringify(expected)}; last seen: ${JSON.stringify(last)}`)
}

async function assertMarkerIntact(sandbox: SandboxInstance, step: string): Promise<void> {
  // The marker lives on the VM's filesystem: if the update had replaced the
  // VM instead of patching it live, the file would be gone.
  const content = await sandbox.fs.read(MARKER_PATH)
  if (content !== MARKER_CONTENT) {
    throw new Error(`Marker file lost or changed after ${step} — the VM was replaced. Got: ${JSON.stringify(content)}`)
  }
  console.log(`  marker file intact after ${step}`)
}

async function main() {
  console.log(`Creating sandbox ${SANDBOX_NAME}...`)
  const sandbox = await SandboxInstance.create({
    name: SANDBOX_NAME,
    image: BASE_IMAGE,
    memory: 2048,
  })
  try {
    await sandbox.wait()
    console.log("Sandbox deployed.")

    console.log("Writing marker file...")
    await sandbox.fs.write(MARKER_PATH, MARKER_CONTENT)

    const before = await readEnv(sandbox, ENV_NAME)
    if (before !== "") {
      throw new Error(`${ENV_NAME} already set before the test: ${JSON.stringify(before)}`)
    }

    console.log(`Setting ${ENV_NAME}=v1 (env-only update)...`)
    await setEnvs(SANDBOX_NAME, [{ name: ENV_NAME, value: "v1" }])
    await waitForEnv(sandbox, "v1", { retries: 30, delayMs: 2000 })
    console.log(`  ${ENV_NAME}=v1 visible in a new process`)
    await assertMarkerIntact(sandbox, "set v1")

    console.log(`Updating ${ENV_NAME}=v2...`)
    await setEnvs(SANDBOX_NAME, [{ name: ENV_NAME, value: "v2" }])
    await waitForEnv(sandbox, "v2", { retries: 30, delayMs: 2000 })
    console.log(`  ${ENV_NAME}=v2 visible in a new process`)
    await assertMarkerIntact(sandbox, "update to v2")

    console.log(`Removing ${ENV_NAME}...`)
    await setEnvs(SANDBOX_NAME, [])
    await waitForEnv(sandbox, "", { retries: 30, delayMs: 2000 })
    console.log(`  ${ENV_NAME} unset in a new process`)
    await assertMarkerIntact(sandbox, "removal")

    console.log("PASS: env updates applied live and the VM was never replaced.")
  } finally {
    console.log(`Deleting sandbox ${SANDBOX_NAME}...`)
    await SandboxInstance.delete(SANDBOX_NAME).catch((e) => console.error(`cleanup failed: ${String(e)}`))
  }
}

main().catch((e) => {
  console.error(`FAIL: ${String(e)}`)
  process.exit(1)
})
