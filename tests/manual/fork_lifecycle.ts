// Manual reproducer: sandbox forks and expiration policies.
//
// Customer report: a fork does not inherit the source's expiration policy,
// fork() has no lifecycle option, and calling updateLifecycle() on the fork
// afterwards redeploys it and loses the files the fork copied.
//
// Flow:
//   1. Create a source sandbox with an expiration policy (spec.lifecycle) and a
//      legacy ttl (spec.runtime.ttl), write a marker file on its rootfs.
//   2. Fork it. Check the fork's record carries the source's lifecycle and ttl,
//      and that the marker was copied.
//   3. Fork it again asking for a lifecycle in the fork request body (the SDK
//      has no option for it, so the raw client is called). Check the fork got it.
//   4. On the first fork: write a second file, read the kernel boot_id, call
//      SandboxInstance.updateLifecycle(). Then check the boot_id did not change
//      (no restart), both files are still there, and the new policy is stored.
//   5. Same update on the source (CONTROL=true), to show whether the restart is
//      fork-specific or affects every sandbox.
//
// Every check that fails is printed as BUG and the script exits 1.
//
// Run (after `cd @blaxel/core && bun run build`):
//
//   BL_ENV=dev BL_WORKSPACE=… BL_API_KEY=… npx tsx tests/manual/fork_lifecycle.ts
//
// Env vars:
//   IMAGE      sandbox image (default blaxel/base-image:latest)
//   REGION     region (default BL_REGION, or us-was-1; fork is not available on eu-dub-1)
//   CONTROL    also run the updateLifecycle check on the (non-fork) source (default "true")
//   CLEANUP    delete every sandbox at the end (default "true")
//   NO_PAUSE   do not stop for the Kubernetes check (by default the script waits
//              for Enter after the forks and after each lifecycle update, and
//              prints the kubectl command showing the pod's janitor annotations)

import { forkSandbox, SandboxInstance, type SandboxLifecycle } from "@blaxel/core"
import { v4 as uuidv4 } from "uuid"

const IMAGE = process.env.IMAGE || "blaxel/base-image:latest"
const REGION = process.env.REGION || process.env.BL_REGION || "us-was-1"
const CONTROL = (process.env.CONTROL ?? "true") === "true"
const CLEANUP = (process.env.CLEANUP ?? "true") === "true"

const id = uuidv4().replace(/-/g, "").substring(0, 8)
const SOURCE = `fork-lc-src-${id}`
const FORK = `fork-lc-dst-${id}`
const FORK_WITH_LC = `fork-lc-opt-${id}`

const SOURCE_TTL = "3h"
const SOURCE_LIFECYCLE: SandboxLifecycle = {
  expirationPolicies: [
    { type: "ttl-max-age", value: "2h", action: "delete" },
    { type: "ttl-idle", value: "1h", action: "delete" },
  ],
}
const REQUESTED_FORK_LIFECYCLE: SandboxLifecycle = {
  expirationPolicies: [{ type: "ttl-max-age", value: "45m", action: "delete" }],
}
const UPDATED_LIFECYCLE: SandboxLifecycle = {
  expirationPolicies: [{ type: "ttl-max-age", value: "30m", action: "delete" }],
}

const COPIED_FILE = "/root/copied-from-source.txt"
const COPIED_BODY = `written-on-source-${id}`
const LOCAL_FILE = "/root/written-on-instance.txt"

const ts = () => new Date().toISOString().slice(11, 23)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const created: string[] = []
const bugs: string[] = []

const errText = (err: unknown): string => {
  if (err instanceof Error) {
    const e = err as Error & { status?: number; body?: unknown; response?: { status?: number }; error?: unknown }
    const status = e.status ?? e.response?.status
    const body = e.body ? ` ${JSON.stringify(e.body)}` : e.error ? ` ${JSON.stringify(e.error)}` : ""
    return `${status ? `${status} ` : ""}${err.message}${body}`
  }
  return typeof err === "string" ? err : JSON.stringify(err)
}

function check(ok: boolean, label: string, detail = "") {
  console.log(`${ts()}   ${ok ? "ok  " : "BUG "} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) bugs.push(`${label}${detail ? ` — ${detail}` : ""}`)
}

// The pod of an mk3 sandbox is sbx-<name>-<workspace id>, and the workspace id
// is the last segment of the first label of the sandbox URL.
function podOf(sbx: SandboxInstance) {
  const host = sbx.metadata.url ? new URL(sbx.metadata.url).hostname.split(".")[0] : ""
  const workspaceId = host.split("-").pop()
  return workspaceId ? `sbx-${sbx.metadata.name}-${workspaceId}` : `<pod of ${sbx.metadata.name}>`
}

async function k8sBreak(step: string, expected: Record<string, SandboxLifecycle | null>) {
  const namespace = `${process.env.BL_ENV === "dev" ? "dev" : "prod"}-${process.env.BL_WORKSPACE}`
  console.log(`\n${ts()} ── Kubernetes check: ${step}`)
  for (const [name, lifecycle] of Object.entries(expected)) {
    const pod = podOf(await SandboxInstance.get(name))
    console.log(`  ${name} expects ${policiesOf(lifecycle)}`)
    console.log(`    kubectl -n ${namespace} get pod ${pod} -o json | jq '.metadata | {creationTimestamp, uid, annotations: (.annotations | with_entries(select(.key | startswith("janitor/") or . == "lastUsedAt")))}'`)
  }
  if (process.env.NO_PAUSE) return
  process.stdout.write(">>> Press Enter to continue (or set NO_PAUSE=1 to skip): ")
  await new Promise<void>((resolve) => {
    process.stdin.resume()
    process.stdin.once("data", () => {
      process.stdin.pause()
      resolve()
    })
  })
}

const policiesOf = (lc: SandboxLifecycle | null | undefined) =>
  JSON.stringify({
    policies: (lc?.expirationPolicies ?? []).map((p) => ({ type: p.type, value: p.value, action: p.action })),
    terminatedRetention: lc?.terminatedRetention ?? null,
  })

// A fork is marked DEPLOYED before its VM has resumed, and an update may take
// the sandbox through a redeploy: retry the exec until the guest answers.
async function exec(sbx: SandboxInstance, command: string, tries = 30): Promise<string> {
  let last: unknown
  for (let i = 0; i < tries; i++) {
    try {
      const r = await sbx.process.exec({ command, waitForCompletion: true })
      if (r.exitCode === 0) return (r.logs ?? "").trim()
      last = new Error(`exit ${r.exitCode}: ${(r.logs ?? "").trim()}`)
    } catch (err) {
      last = err
    }
    await sleep(1000)
  }
  throw new Error(`exec "${command}" failed after ${tries} tries: ${errText(last)}`)
}

const bootId = (sbx: SandboxInstance) => exec(sbx, "cat /proc/sys/kernel/random/boot_id")
const readFile = async (sbx: SandboxInstance, path: string) => {
  try {
    return await exec(sbx, `cat ${path}`, 3)
  } catch (err) {
    console.log(`${ts()}   read ${path} on ${sbx.metadata.name} failed: ${errText(err)}`)
    return undefined
  }
}

// updateLifecycle() on an instance, then prove the instance was left running.
async function updateLifecycleKeepsInstance(name: string, label: string) {
  console.log(`${ts()} [${label}] updateLifecycle on ${name}`)
  const before = await SandboxInstance.get(name)
  const localBody = `written-on-${label}-${id}`
  await exec(before, `echo -n ${localBody} > ${LOCAL_FILE}`)
  const bootBefore = await bootId(before)
  const copiedBefore = await readFile(before, COPIED_FILE)
  console.log(`${ts()}   before: status=${before.status} boot_id=${bootBefore}`)

  // Watch the record during the call and for a few seconds after it: a
  // redeploy shows up as DEPLOYING.
  const statuses: string[] = []
  let watchUntil = Infinity
  const watcher = (async () => {
    while (Date.now() < watchUntil) {
      const s = (await SandboxInstance.get(name)).status ?? "?"
      if (statuses[statuses.length - 1] !== s) statuses.push(s)
      await sleep(500)
    }
  })()

  const start = Date.now()
  try {
    await SandboxInstance.updateLifecycle(name, UPDATED_LIFECYCLE)
  } catch (err) {
    watchUntil = 0
    await watcher
    check(false, `${label}: updateLifecycle accepted`, errText(err))
    return
  }
  console.log(`${ts()}   updateLifecycle returned in ${Date.now() - start}ms`)
  watchUntil = Date.now() + 10_000
  await watcher
  const after = await SandboxInstance.get(name)
  const bootAfter = await bootId(after)
  const localAfter = await readFile(after, LOCAL_FILE)
  const copiedAfter = await readFile(after, COPIED_FILE)
  console.log(`${ts()}   after:  statuses=${statuses.join(" → ")} boot_id=${bootAfter}`)
  const events = (after.events ?? []).slice(-4).map((e) => `${e.type}/${e.status}`).join(", ")
  console.log(`${ts()}   last events: ${events}`)

  await k8sBreak(`after updateLifecycle on ${name} (pod must keep its uid/creationTimestamp)`, { [name]: UPDATED_LIFECYCLE })

  check(policiesOf(after.spec.lifecycle) === policiesOf(UPDATED_LIFECYCLE), `${label}: new lifecycle stored`, policiesOf(after.spec.lifecycle))
  check(!statuses.some((s) => s !== "DEPLOYED"), `${label}: status stayed DEPLOYED`, statuses.join(" → "))
  check(bootAfter === bootBefore, `${label}: instance not restarted (same boot_id)`, `${bootBefore} → ${bootAfter}`)
  check(localAfter === localBody, `${label}: file written before the update survives`, `${LOCAL_FILE}=${localAfter ?? "<missing>"}`)
  if (copiedBefore !== undefined) {
    check(copiedAfter === copiedBefore, `${label}: file copied by the fork survives`, `${COPIED_FILE}=${copiedAfter ?? "<missing>"}`)
  }
}

async function main() {
  console.log(`${ts()} env=${process.env.BL_ENV ?? "prod"} workspace=${process.env.BL_WORKSPACE} region=${REGION} image=${IMAGE}`)

  // 1. source
  const source = await SandboxInstance.create({
    name: SOURCE,
    image: IMAGE,
    region: REGION,
    ttl: SOURCE_TTL,
    lifecycle: SOURCE_LIFECYCLE,
    labels: { env: "manual-test", "created-by": "fork_lifecycle" },
  })
  created.push(SOURCE)
  const src = await SandboxInstance.get(SOURCE)
  console.log(`${ts()} [source] ${SOURCE} status=${src.status} ttl=${src.spec.runtime?.ttl} lifecycle=${policiesOf(src.spec.lifecycle)}`)
  await exec(source, `echo -n ${COPIED_BODY} > ${COPIED_FILE}`)

  // 2. plain fork
  console.log(`${ts()} [fork] ${SOURCE} → ${FORK}`)
  const forkStart = Date.now()
  await source.fork(FORK)
  created.push(FORK)
  const fork = await SandboxInstance.get(FORK)
  console.log(`${ts()}   fork returned in ${Date.now() - forkStart}ms status=${fork.status} ttl=${fork.spec.runtime?.ttl} lifecycle=${policiesOf(fork.spec.lifecycle)}`)
  check(policiesOf(fork.spec.lifecycle) === policiesOf(src.spec.lifecycle), "fork inherits spec.lifecycle", `source=${policiesOf(src.spec.lifecycle)} fork=${policiesOf(fork.spec.lifecycle)}`)
  check(fork.spec.runtime?.ttl === src.spec.runtime?.ttl, "fork inherits spec.runtime.ttl", `source=${src.spec.runtime?.ttl} fork=${fork.spec.runtime?.ttl}`)
  const forkCopied = await readFile(fork, COPIED_FILE)
  check(forkCopied === COPIED_BODY, "fork has the source's files", `${COPIED_FILE}=${forkCopied ?? "<missing>"}`)

  // 3. fork with a lifecycle in the request
  console.log(`${ts()} [fork+lifecycle] ${SOURCE} → ${FORK_WITH_LC} with ${policiesOf(REQUESTED_FORK_LIFECYCLE)}`)
  try {
    await forkSandbox({
      path: { sandboxName: SOURCE },
      body: { targetName: FORK_WITH_LC, targetType: "sandbox", lifecycle: REQUESTED_FORK_LIFECYCLE } as Parameters<typeof forkSandbox>[0]["body"],
      throwOnError: true,
    })
    created.push(FORK_WITH_LC)
    const withLc = await SandboxInstance.get(FORK_WITH_LC)
    check(policiesOf(withLc.spec.lifecycle) === policiesOf(REQUESTED_FORK_LIFECYCLE), "fork request honors lifecycle", `fork=${policiesOf(withLc.spec.lifecycle)}`)
  } catch (err) {
    check(false, "fork request with lifecycle accepted", errText(err))
  }

  const expected: Record<string, SandboxLifecycle | null> = { [SOURCE]: SOURCE_LIFECYCLE, [FORK]: SOURCE_LIFECYCLE }
  if (created.includes(FORK_WITH_LC)) expected[FORK_WITH_LC] = REQUESTED_FORK_LIFECYCLE
  await k8sBreak("after the forks", expected)

  // 4. updateLifecycle on the fork
  await updateLifecycleKeepsInstance(FORK, "fork")

  // 5. control: updateLifecycle on a sandbox that is not a fork
  if (CONTROL) await updateLifecycleKeepsInstance(SOURCE, "source")
}

async function cleanup() {
  if (!CLEANUP) {
    console.log(`${ts()} CLEANUP=false, keeping ${created.join(", ")}`)
    return
  }
  for (const name of created.reverse()) {
    try {
      await SandboxInstance.delete(name)
    } catch (err) {
      console.error(`${ts()} delete ${name} failed: ${errText(err)}`)
    }
  }
}

try {
  await main()
} catch (err) {
  bugs.push(`aborted: ${errText(err)}`)
  console.error(`${ts()} ABORTED: ${errText(err)}`)
} finally {
  await cleanup()
}
console.log(`\n${bugs.length === 0 ? "PASS" : `FAIL (${bugs.length})`}`)
for (const b of bugs) console.log(`  - ${b}`)
process.exit(bugs.length === 0 ? 0 : 1)
