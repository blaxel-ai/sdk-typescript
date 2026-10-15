/**
 * Manual end-to-end test for forking a sandbox with new environment variables.
 *
 * `sandbox.fork(name, { envs })` sends the variables the fork should run with
 * on top of the ones the source has: a variable the source already carries
 * takes the value given here, one it does not is added, and every other
 * variable of the source is kept. The fork boots with that environment
 * already applied — no second update call.
 *
 * Flow:
 *   1. Create a source sandbox carrying MODE=source and SOURCE_ONLY=1.
 *   2. Read both back from a process inside it.
 *   3. Fork it with envs = [MODE=fork, FORK_ONLY=1].
 *   4. Assert a process in the fork sees MODE=fork (replaced),
 *      SOURCE_ONLY=1 (inherited) and FORK_ONLY=1 (added).
 *   5. Assert the source still sees MODE=source and no FORK_ONLY.
 *   6. Clean up both sandboxes (KEEP=1 to inspect them instead).
 *
 * This lives under tests/manual because it creates two real sandboxes and
 * forks between them, well past the 1-minute budget of the integration suite.
 *
 * Credentials are picked up automatically via @blaxel/core autoload (local
 * `bl login` config / env), so BL_WORKSPACE / BL_API_KEY are not required here.
 * BL_ENV=dev targets api.blaxel.dev.
 *
 * Run (after `npm run build` in @blaxel/core):
 *
 *   npx tsx tests/manual/fork_with_environment.ts
 *
 * Env vars:
 *   NAME     source sandbox name (default: fork-env-<random>)
 *   IMAGE    sandbox image (default blaxel/base-image:latest)
 *   REGION   region to create the source sandbox in (optional)
 *   KEEP     set to 1 to keep both sandboxes for inspection
 */

// Disable H2 to work around PM-2160 (h2 stream unref -> event loop exits mid-await).
// Must be set BEFORE importing @blaxel/core.
process.env.BL_DISABLE_H2 = process.env.BL_DISABLE_H2 ?? "1"

import { SandboxInstance } from "@blaxel/core"
import { v4 as uuidv4 } from "uuid"

const IMAGE = process.env.IMAGE || "blaxel/base-image:latest"
const REGION = process.env.REGION
const KEEP = process.env.KEEP === "1"
const LABELS = { env: "manual-test", "created-by": "fork-with-environment" }

const t0 = Date.now()

function uniqueName(prefix: string): string {
  return `${prefix}-${uuidv4().replace(/-/g, "").substring(0, 8)}`
}

function log(msg: string) {
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Read the environment a freshly spawned process in the sandbox inherits. */
async function readEnv(sandbox: SandboxInstance, names: string[]): Promise<Record<string, string>> {
  const script = names.map((name) => `printf "${name}=%s\\n" "$${name}"`).join("; ")
  const result = (await sandbox.process.exec({
    command: `sh -c '${script}'`,
    waitForCompletion: true,
  })) as { logs?: string }
  const env: Record<string, string> = {}
  for (const line of (result.logs ?? "").split("\n")) {
    const separator = line.indexOf("=")
    if (separator > 0) env[line.slice(0, separator)] = line.slice(separator + 1).trim()
  }
  return env
}

/** Retry until the fork answers: a fork returns before its guest has resumed. */
async function readEnvWhenUp(
  sandbox: SandboxInstance,
  names: string[],
  { retries, delayMs }: { retries: number; delayMs: number },
): Promise<Record<string, string>> {
  let lastError: unknown
  for (let i = 0; i < retries; i++) {
    try {
      return await readEnv(sandbox, names)
    } catch (e) {
      lastError = e
      await sleep(delayMs)
    }
  }
  throw new Error(`${sandbox.metadata.name} never answered: ${String(lastError)}`)
}

function assertEnv(label: string, env: Record<string, string>, expected: Record<string, string>) {
  for (const [name, value] of Object.entries(expected)) {
    if ((env[name] ?? "") !== value) {
      throw new Error(`${label}: expected ${name}=${JSON.stringify(value)}, got ${JSON.stringify(env[name] ?? "")}`)
    }
  }
  console.log(`  ${label} ✔ ${JSON.stringify(expected)}`)
}

async function main() {
  const sourceName = process.env.NAME || uniqueName("fork-env")
  const forkName = `${sourceName}-fork`
  const created: string[] = []
  const watched = ["MODE", "SOURCE_ONLY", "FORK_ONLY"]

  try {
    log(`creating source sandbox ${sourceName} with MODE=source SOURCE_ONLY=1`)
    const source = await SandboxInstance.create({
      name: sourceName,
      image: IMAGE,
      memory: 2048,
      labels: LABELS,
      ...(REGION ? { region: REGION } : {}),
      envs: [
        { name: "MODE", value: "source" },
        { name: "SOURCE_ONLY", value: "1" },
      ],
    })
    created.push(sourceName)
    assertEnv("source before fork", await readEnvWhenUp(source, watched, { retries: 15, delayMs: 2000 }), {
      MODE: "source",
      SOURCE_ONLY: "1",
      FORK_ONLY: "",
    })

    log(`forking ${sourceName} -> ${forkName} with MODE=fork FORK_ONLY=1`)
    const forked = await source.fork(forkName, {
      envs: [
        { name: "MODE", value: "fork" },
        { name: "FORK_ONLY", value: "1" },
      ],
    })
    created.push(forkName)
    log(`forked into ${forked.type}: ${forked.name}`)

    const fork = await SandboxInstance.get(forkName)
    // Printed before the guest is read: it tells apart what the control plane
    // recorded from what the guest actually runs with.
    console.log(`  fork spec.runtime.envs: ${JSON.stringify(fork.spec.runtime?.envs ?? [])}`)
    assertEnv("fork", await readEnvWhenUp(fork, watched, { retries: 30, delayMs: 2000 }), {
      MODE: "fork",
      SOURCE_ONLY: "1",
      FORK_ONLY: "1",
    })

    // The fork carries its own environment; the source is left as it was.
    assertEnv("source after fork", await readEnv(source, watched), {
      MODE: "source",
      SOURCE_ONLY: "1",
      FORK_ONLY: "",
    })

    console.log("\n✅ Fork with new environment variables: replaced, inherited and added all verified.")
  } finally {
    if (KEEP) {
      console.log(`\n🔍 KEEP=1, leaving ${created.join(", ")} in place`)
    } else {
      console.log("\n🧹 Cleaning up...")
      for (const name of created) {
        try {
          await SandboxInstance.delete(name)
          console.log(`  deleted sandbox ${name}`)
        } catch (e) {
          console.warn(`  failed to delete ${name}: ${(e as Error).message}`)
        }
      }
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
