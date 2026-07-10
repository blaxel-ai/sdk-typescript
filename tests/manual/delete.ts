/**
 * Delete all sandboxes in the current workspace.
 *
 * Fetches every sandbox (paginated) and deletes them concurrently in
 * bounded batches, so it stays efficient even with thousands of sandboxes
 * without overwhelming the API.
 *
 * Requires BL_WORKSPACE + BL_API_KEY (or `bl login`).
 *
 * Run:
 *   npx tsx tests/manual/delete.ts
 *   npx tsx tests/manual/delete.ts --dry-run
 *   npx tsx tests/manual/delete.ts --label env=staging
 *   npx tsx tests/manual/delete.ts --concurrency 20
 */

import { SandboxInstance } from "@blaxel/core"

const args = process.argv.slice(2)
const DRY_RUN = args.includes("--dry-run")
const CONCURRENCY = Number(readFlag("--concurrency") ?? "10")
const LABEL_FILTER = parseLabelFilter(readFlag("--label"))

function readFlag(name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  return args[index + 1]
}

function parseLabelFilter(raw?: string): [string, string] | null {
  if (!raw) return null
  const [key, value] = raw.split("=")
  if (!key || value === undefined) {
    throw new Error(`Invalid --label value "${raw}", expected key=value`)
  }
  return [key, value]
}

function matchesLabelFilter(sandbox: SandboxInstance): boolean {
  if (!LABEL_FILTER) return true
  const [key, value] = LABEL_FILTER
  return sandbox.metadata?.labels?.[key] === value
}

async function collectSandboxNames(): Promise<string[]> {
  const names: string[] = []
  let page = await SandboxInstance.list({ limit: 200 })
  let pageIndex = 0
  while (true) {
    pageIndex++
    console.log(`  page ${pageIndex}: got ${page.data.length} sandbox(es), hasMore=${page.hasMore}`)
    for (const sandbox of page.data) {
      if (matchesLabelFilter(sandbox)) {
        names.push(sandbox.metadata!.name!)
      }
    }
    const next = await page.nextPage()
    if (pageIndex >= 10) break
    if (!next) break
    page = next
  }
  return names
}

async function deleteAll(names: string[]): Promise<void> {
  let done = 0
  let failed = 0

  for (let i = 0; i < names.length; i += CONCURRENCY) {
    const batch = names.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map((name) => SandboxInstance.delete(name)),
    )
    for (let j = 0; j < results.length; j++) {
      const result = results[j]
      const name = batch[j]
      if (result.status === "fulfilled") {
        done++
        console.log(`[${done + failed}/${names.length}] Deleted ${name}`)
      } else {
        failed++
        console.error(`[${done + failed}/${names.length}] Failed to delete ${name}: ${result.reason}`)
      }
    }
  }

  console.log(`\nDone. Deleted ${done}/${names.length} sandboxes${failed ? `, ${failed} failed` : ""}.`)
}

async function main() {
  console.log("Fetching sandboxes...")
  const names = await collectSandboxNames()

  if (names.length === 0) {
    console.log("No sandboxes found.")
    return
  }

  console.log(`Found ${names.length} sandbox(es)${LABEL_FILTER ? ` matching label ${LABEL_FILTER[0]}=${LABEL_FILTER[1]}` : ""}.`)

  if (DRY_RUN) {
    for (const name of names) console.log(`  - ${name}`)
    console.log("\nDry run, nothing deleted.")
    return
  }

  await deleteAll(names)
}

await main()
