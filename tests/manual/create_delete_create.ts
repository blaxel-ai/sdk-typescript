/**
 * create -> delete -> create again on the same name, without waiting for the
 * deletion to land. Shows what the control plane answers while the row is
 * still DELETING or while another creation of the same name is in flight.
 *
 *   - Before controlplane#5585: a single create during a fast delete already
 *     fits in the backend's 5s wait and gets 200, but PARALLEL createIfNotExists
 *     on one name (fresh, or racing the delete) get 409 SANDBOX_ALREADY_EXISTS.
 *   - After: createIfNotExists waits it out (1s/2s/4s backoff) and every racer
 *     returns 200. A plain create still gets the 409.
 *
 * Usage:
 *   tsx tests/manual/create_delete_create.ts                # 10 racers x 3 rounds (reproduces the 409 on prod)
 *   PARALLEL=1 tsx tests/manual/create_delete_create.ts     # single create during the delete (no 409 on prod)
 *   tsx tests/manual/create_delete_create.ts --plain        # plain create instead of createIfNotExists
 *   BL_ENV=dev BL_REGION=eu-dub-1 tsx tests/manual/create_delete_create.ts
 *
 * ROUNDS repeats the delete + recreate cycle on the same name. With PARALLEL>1
 * the first creation is also done by PARALLEL concurrent racers on the fresh
 * name (the pure concurrent-creation race).
 *
 * The backend only answers 409 when a creation or a deletion of the name takes
 * longer than its 5s wait, which on prod needs the workspace to be busy (CI hits
 * it because the whole integration suite creates/deletes sandboxes at the same
 * time). LOAD=N keeps N create->delete loops on other names running during the
 * rounds to slow the control plane down the same way; BL_REGION=us-was-1 is
 * what CI uses.
 */
import { SandboxInstance, settings } from "@blaxel/core"

const PLAIN = process.argv.includes("--plain")
const ROUNDS = parseInt(process.env.ROUNDS || "3", 10)
const PARALLEL = parseInt(process.env.PARALLEL || "10", 10)
const LOAD = parseInt(process.env.LOAD || "0", 10)
const IMAGE = process.env.IMAGE || "blaxel/base-image:latest"
const NAME = `create-delete-create-${Math.random().toString(36).slice(2, 8)}`
const SPEC = { name: NAME, image: IMAGE, memory: 2048 }

type ApiError = { error?: string; code?: string; status?: number; status_code?: number }

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  const e = err as ApiError
  return JSON.stringify({ status: e.status ?? e.status_code, code: e.code, error: e.error })
}

function createOnce(): Promise<SandboxInstance> {
  return PLAIN ? SandboxInstance.create(SPEC) : SandboxInstance.createIfNotExists(SPEC)
}

async function statusOf(name: string): Promise<string> {
  try {
    const sb = await SandboxInstance.get(name)
    return sb.status ?? "unknown"
  } catch (err) {
    return `get failed: ${describeError(err)}`
  }
}

/** Fires `PARALLEL` creates (plus `extra`, e.g. the delete) together and logs each outcome. */
async function race(label: string, extra: Promise<unknown>[] = []): Promise<SandboxInstance | undefined> {
  const t0 = Date.now()
  const results = await Promise.allSettled([...extra, ...Array.from({ length: PARALLEL }, createOnce)])
  const creates = results.slice(extra.length)
  const ok = creates.filter((r): r is PromiseFulfilledResult<SandboxInstance> => r.status === "fulfilled")
  console.log(`[${label}] ${ok.length}/${PARALLEL} ok in ${Date.now() - t0}ms`)
  creates.forEach((r, i) => {
    if (r.status === "rejected") console.log(`   call#${i} FAILED: ${describeError(r.reason)}`)
  })
  const rows = new Set(ok.map((r) => r.value.metadata.createdAt))
  if (ok.length) console.log(`   createdAt seen: ${[...rows].join(", ")}`)
  return ok[0]?.value
}

/**
 * LOAD independent names, each doing create -> delete -> create again in a loop.
 * Besides slowing the control plane down like a busy workspace, every iteration
 * is itself a "create while the previous row is still DELETING": with the
 * deletion pushed past the backend's 5s wait, this is where the 409 shows up.
 */
function startLoad(stop: { done: boolean }, conflicts: string[]): Promise<void>[] {
  return Array.from({ length: LOAD }, async (_, i) => {
    const name = `${NAME}-load-${i}`
    const spec = { ...SPEC, name }
    let iteration = 0
    while (!stop.done) {
      iteration++
      try {
        await (PLAIN ? SandboxInstance.create(spec) : SandboxInstance.createIfNotExists(spec))
        await SandboxInstance.delete(name)
      } catch (err) {
        const msg = `load#${i} iteration ${iteration}: ${describeError(err)}`
        console.log(`   ${msg}`)
        if (describeError(err).includes("409")) conflicts.push(msg)
        await new Promise((r) => setTimeout(r, 2_000))
      }
    }
    await SandboxInstance.delete(name).catch(() => undefined)
  })
}

async function main() {
  console.log(`api=${settings.baseUrl} workspace=${settings.workspace} name=${NAME} mode=${PLAIN ? "create" : "createIfNotExists"} rounds=${ROUNDS} parallel=${PARALLEL} load=${LOAD}`)
  const stop = { done: false }
  const conflicts: string[] = []
  const load = startLoad(stop, conflicts)
  if (LOAD) await new Promise((r) => setTimeout(r, 3_000))

  let current = await race("1. create (fresh name)")
  if (!current) process.exit(1)

  let failedRounds = 0
  for (let i = 1; i <= ROUNDS; i++) {
    console.log(`--- round ${i}/${ROUNDS}`)
    const before = current.metadata.createdAt
    const del = SandboxInstance.delete(NAME).then(
      () => console.log("   delete ok"),
      (err: unknown) => console.log(`   delete FAILED: ${describeError(err)}`),
    )
    const next = await race("2. delete + create", [del])
    console.log(`   status now: ${await statusOf(NAME)}`)
    if (!next) {
      failedRounds++
      // The name is still held by the deleting row; give it a moment so the
      // next round starts from a live sandbox again.
      await new Promise((r) => setTimeout(r, 10_000))
      current = (await race("   recover create")) ?? current
    } else {
      console.log(`   ${next.metadata.createdAt === before ? "SAME row as before the delete" : "new row"}`)
      current = next
    }
  }

  stop.done = true
  await Promise.all(load)
  await SandboxInstance.delete(NAME).catch((err: unknown) => console.log(`cleanup delete FAILED: ${describeError(err)}`))
  console.log(`${ROUNDS - failedRounds}/${ROUNDS} rounds re-created the sandbox while it was deleting`)
  if (LOAD) console.log(`${conflicts.length} 409s in the ${LOAD} background create->delete->create loops`)
  process.exit(failedRounds || conflicts.length ? 2 : 0)
}

main().catch((err) => {
  console.error(describeError(err))
  process.exit(1)
})
