/**
 * Create a sandbox with ttl=0s and fork it immediately.
 *
 * Use this to manually inspect what TTL (if any) the fork inherits when the
 * source is created with a zero TTL.
 *
 * Does not delete the sandboxes — inspect them with `bl get sandbox <name>`
 * (or the control plane) and clean up when done.
 *
 * Requires: BL_WORKSPACE, BL_API_KEY
 *
 * Run:
 *   cd @blaxel/core && npm run build && cd ../..
 *   npx tsx tests/manual/fork-ttl-zero.ts
 *
 * Optional:
 *   TTL=0s          source TTL (default 0s)
 *   BL_REGION=...   region override
 */

import { SandboxInstance } from "@blaxel/core"

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function summarize(label: string, sandbox: SandboxInstance) {
  const ttl = sandbox.spec?.runtime?.ttl ?? null
  const expires = sandbox.spec?.runtime?.expires ?? null
  const lifecycle = sandbox.spec?.lifecycle ?? null
  console.log(`\n[${label}]`)
  console.log(`  name:      ${sandbox.metadata?.name}`)
  console.log(`  status:    ${sandbox.status}`)
  console.log(`  ttl:       ${JSON.stringify(ttl)}`)
  console.log(`  expires:   ${JSON.stringify(expires)}`)
  console.log(`  lifecycle: ${JSON.stringify(lifecycle)}`)
}

const TTL = process.env.TTL ?? "0s"
const REGION = process.env.BL_REGION
const sourceName = uniqueName("fork-ttl-src")
const forkName = uniqueName("fork-ttl-dst")

async function main() {
  console.log(`Creating source sandbox ${sourceName} with ttl=${TTL}`)
  const source = await SandboxInstance.create({
    name: sourceName,
    image: "blaxel/base-image:latest",
    memory: 4096,
    ...(REGION ? { region: REGION } : {}),
    ttl: TTL,
    labels: {
      env: "manual-test",
      "created-by": "fork-ttl-zero",
    },
  })
  summarize("source (after create)", source)

  console.log(`\nForking ${sourceName} -> ${forkName} immediately...`)
  const forkResult = await source.fork(forkName, { targetType: "sandbox" })
  console.log(`  fork API returned type=${forkResult.type} name=${forkResult.name}`)

  const forked = await SandboxInstance.get(forkName)
  summarize("fork (after get)", forked)

  // Re-fetch source in case status/ttl changed during the fork.
  const sourceAfter = await SandboxInstance.get(sourceName)
  summarize("source (after fork)", sourceAfter)

  console.log("\nSandboxes left running for manual inspection:")
  console.log(`  source: ${sourceName}`)
  console.log(`  fork:   ${forkName}`)
  console.log("\nInspect with:")
  console.log(`  bl get sandbox ${sourceName}`)
  console.log(`  bl get sandbox ${forkName}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
