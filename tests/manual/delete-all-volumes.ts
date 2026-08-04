/**
 * Delete every volume in the current Blaxel workspace, along with any sandbox
 * reported as attached to one of those volumes.
 *
 * The script repeatedly lists 50 volumes and deletes that batch. Volumes that
 * fail to delete are skipped so they do not prevent later volumes from being
 * processed. For each batch, attached sandboxes are deleted first and the
 * script waits for their full deletion before deleting the volumes.
 *
 * Requires: BL_WORKSPACE, BL_API_KEY
 *
 * Run:
 *   cd @blaxel/core && npm run build && cd ../..
 *   npx tsx tests/manual/delete-all-volumes.ts
 */

import { SandboxInstance, settings, VolumeInstance } from "@blaxel/core"

const BATCH_SIZE = 50
const SANDBOX_DELETE_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 1_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error

  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

async function waitForSandboxDeletion(name: string): Promise<boolean> {
  const deadline = Date.now() + SANDBOX_DELETE_TIMEOUT_MS

  while (Date.now() < deadline) {
    try {
      const sandbox = await SandboxInstance.get(name)
      if (sandbox.status === "TERMINATED") return true
    } catch {
      return true
    }

    await sleep(POLL_INTERVAL_MS)
  }

  return false
}

async function main(): Promise<void> {
  if (!settings.workspace) {
    throw new Error("BL_WORKSPACE must be set (or configured in ~/.blaxel/config.yaml)")
  }

  let deletedCount = 0
  let deletedSandboxCount = 0
  let batchNumber = 0
  const failedNames = new Set<string>()
  const deletedSandboxNames = new Set<string>()

  console.log(`Deleting all volumes from workspace "${settings.workspace}"...`)

  while (true) {
    let page = await VolumeInstance.list({ limit: BATCH_SIZE })
    let volumes = page.data.filter(
      (volume) => Boolean(volume.name) && !failedNames.has(volume.name),
    )

    // If a page contains only previously failed volumes, walk forward until
    // another deletable batch is found.
    while (volumes.length === 0 && page.hasMore) {
      const nextPage = await page.nextPage()
      if (!nextPage) break

      page = nextPage
      volumes = page.data.filter(
        (volume) => Boolean(volume.name) && !failedNames.has(volume.name),
      )
    }

    if (volumes.length === 0) {
      console.log(
        `Done. Deleted ${deletedCount} volume(s) and ${deletedSandboxCount} attached sandbox(es).`,
      )
      if (failedNames.size > 0) {
        console.warn(
          `Could not delete ${failedNames.size} volume(s): ${[...failedNames].join(", ")}`,
        )
      }
      return
    }

    batchNumber++
    console.log(`Batch ${batchNumber}: preparing ${volumes.length} volume(s)...`)

    const attachedSandboxNames = new Set<string>()
    for (const volume of volumes) {
      const attachedTo = volume.state?.attachedTo
      if (attachedTo?.startsWith("sandbox:")) {
        const sandboxName = attachedTo.slice("sandbox:".length)
        if (sandboxName) attachedSandboxNames.add(sandboxName)
      }
    }

    for (const name of deletedSandboxNames) attachedSandboxNames.delete(name)

    if (attachedSandboxNames.size > 0) {
      console.log(`  deleting ${attachedSandboxNames.size} attached sandbox(es)...`)

      const sandboxResults = await Promise.allSettled(
        [...attachedSandboxNames].map(async (name) => {
          try {
            await SandboxInstance.delete(name)
          } catch (error) {
            // A sandbox may already be deleting. Treat it as successful if it
            // reaches a terminal/deleted state before the timeout.
            const alreadyDeleted = await waitForSandboxDeletion(name)
            if (!alreadyDeleted) throw error
          }

          const deleted = await waitForSandboxDeletion(name)
          if (!deleted) {
            throw new Error(`timed out waiting ${SANDBOX_DELETE_TIMEOUT_MS / 1000}s for deletion`)
          }

          deletedSandboxNames.add(name)
          deletedSandboxCount++
          console.log(`  deleted sandbox ${name}`)
        }),
      )

      sandboxResults.forEach((result, index) => {
        if (result.status === "rejected") {
          const name = [...attachedSandboxNames][index] ?? "<unknown>"
          console.error(`  failed to delete sandbox ${name}: ${formatError(result.reason)}`)
        }
      })
    }

    console.log(`  deleting ${volumes.length} volume(s)...`)

    const results = await Promise.allSettled(
      volumes.map(async (volume) => {
        const name = volume.name
        if (!name) throw new Error("Listed volume has no name")

        await VolumeInstance.delete(name)
        console.log(`  deleted ${name}`)
      }),
    )

    const failures = results.flatMap((result, index) =>
      result.status === "rejected"
        ? [{
            name: volumes[index]?.name ?? "<unknown>",
            reason: result.reason,
          }]
        : [],
    )

    deletedCount += results.length - failures.length

    if (failures.length > 0) {
      for (const failure of failures) {
        console.error(`  failed to delete ${failure.name}: ${formatError(failure.reason)}`)
        failedNames.add(failure.name)
      }
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
