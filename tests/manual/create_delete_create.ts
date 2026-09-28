/**
 * create -> delete -> create again on the same name, without waiting for the
 * deletion to land. Shows what the control plane answers while the row is
 * still DELETING.
 *
 *   - Before controlplane#5585: 409 SANDBOX_ALREADY_EXISTS after ~5s.
 *   - After: createIfNotExists waits it out (1s/2s/4s backoff) and returns 200.
 *     A plain create still gets the 409.
 *
 * Usage:
 *   npx tsx tests/manual/create_delete_create.ts            # createIfNotExists
 *   npx tsx tests/manual/create_delete_create.ts --plain    # plain create
 *   BL_ENV=dev BL_REGION=eu-dub-1 ROUNDS=5 npx tsx tests/manual/create_delete_create.ts
 *
 * ROUNDS repeats the cycle on the same name: the 409 only shows up when the
 * deletion takes longer than the control plane's wait, so several rounds give
 * it a chance to happen.
 */
import { SandboxInstance, settings } from "@blaxel/core"

const PLAIN = process.argv.includes("--plain")
const ROUNDS = parseInt(process.env.ROUNDS || "1", 10)
const IMAGE = "blaxel/base-image:latest"
const NAME = `create-delete-create-${Math.random().toString(36).slice(2, 8)}`

type ApiError = { error?: string; code?: string; status?: number }

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  const e = err as ApiError
  return JSON.stringify({ status: e.status, code: e.code, error: e.error })
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  const t0 = Date.now()
  try {
    const result = await fn()
    console.log(`[${label}] ok in ${Date.now() - t0}ms`)
    return result
  } catch (err) {
    console.log(`[${label}] FAILED in ${Date.now() - t0}ms: ${describeError(err)}`)
    return undefined
  }
}

async function statusOf(name: string): Promise<string> {
  try {
    const sb = await SandboxInstance.get(name)
    return sb.status ?? "unknown"
  } catch (err) {
    return `get failed: ${describeError(err)}`
  }
}

async function round(first: SandboxInstance): Promise<SandboxInstance | undefined> {
  await timed("2. delete", () => SandboxInstance.delete(NAME))
  console.log(`   status right after delete: ${await statusOf(NAME)}`)

  const second = await timed(PLAIN ? "3. create (plain)" : "3. createIfNotExists", () =>
    PLAIN
      ? SandboxInstance.create({ name: NAME, image: IMAGE, memory: 2048 })
      : SandboxInstance.createIfNotExists({ name: NAME, image: IMAGE, memory: 2048 }),
  )
  if (second) {
    const recreated = second.metadata.createdAt !== first.metadata.createdAt
    console.log(`   returned status=${second.status} ${recreated ? "new row" : "SAME row as before the delete"} createdAt=${second.metadata.createdAt}`)
  }
  console.log(`   status now: ${await statusOf(NAME)}`)
  return second
}

async function main() {
  console.log(`api=${settings.baseUrl} workspace=${settings.workspace} name=${NAME} mode=${PLAIN ? "create" : "createIfNotExists"} rounds=${ROUNDS}`)

  let current = await timed("1. create", () =>
    SandboxInstance.create({ name: NAME, image: IMAGE, memory: 2048 }),
  )
  if (!current) process.exit(1)

  let failures = 0
  for (let i = 1; i <= ROUNDS; i++) {
    console.log(`--- round ${i}/${ROUNDS}`)
    const next = await round(current)
    if (!next) {
      failures++
      // The name is still held by the deleting row; wait for it to go so the
      // next round starts from a live sandbox again.
      current = (await timed("   recover create", () => SandboxInstance.create({ name: NAME, image: IMAGE, memory: 2048 }).catch(async () => {
        await new Promise((r) => setTimeout(r, 10_000))
        return SandboxInstance.create({ name: NAME, image: IMAGE, memory: 2048 })
      }))) ?? current
    } else {
      current = next
    }
  }

  await timed("4. cleanup delete", () => SandboxInstance.delete(NAME))
  console.log(`${ROUNDS - failures}/${ROUNDS} rounds re-created the sandbox while it was deleting`)
  process.exit(failures ? 2 : 0)
}

main().catch((err) => {
  console.error(describeError(err))
  process.exit(1)
})
