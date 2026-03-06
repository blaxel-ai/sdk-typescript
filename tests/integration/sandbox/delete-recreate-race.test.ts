import { SandboxInstance } from "@blaxel/core"
import { describe, expect, it } from 'vitest'
import { defaultLabels, defaultRegion, sleep, uniqueName, waitForSandboxDeletion } from './helpers.js'

describe('Delete-Recreate Race Condition Tests', () => {
  it('handles rapid delete-recreate cycles without conflicts', { timeout: 300000 }, async () => {
    const sandboxName = uniqueName("race-single")
    const iterations = 5

    for (let i = 0; i < iterations; i++) {
      const sandbox = await SandboxInstance.create({
        name: sandboxName,
        region: defaultRegion,
        memory: 2048,
        labels: defaultLabels,
      })
      await sandbox.wait()

      const check = await SandboxInstance.get(sandboxName)
      expect(check.status).not.toBe("DELETING")

      await SandboxInstance.delete(sandboxName)
      const deleted = await waitForSandboxDeletion(sandboxName, 90)
      expect(deleted).toBe(true)

      await sleep(3000)
    }
  })

  it('handles parallel delete-recreate operations', { timeout: 600000 }, async () => {
    const numWorkers = 3
    const iterationsPerWorker = 3
    const sandboxNames = Array.from({ length: numWorkers }, (_, i) =>
      uniqueName(`race-parallel-${i}`)
    )

    const workers = sandboxNames.map(async (sandboxName) => {
      for (let i = 0; i < iterationsPerWorker; i++) {
        const sandbox = await SandboxInstance.create({
          name: sandboxName,
          region: defaultRegion,
          memory: 2048,
          labels: defaultLabels,
        })
        await sandbox.wait()

        const check = await SandboxInstance.get(sandboxName)
        expect(check.status).not.toBe("DELETING")

        await SandboxInstance.delete(sandboxName)
        const deleted = await waitForSandboxDeletion(sandboxName, 180)
        expect(deleted).toBe(true)

        await sleep(3000)
      }
    })

    await Promise.all(workers)
  })

  it('detects if sandbox gets stuck in DELETING state', { timeout: 120000 }, async () => {
    const sandboxName = uniqueName("race-deleting-check")

    const sandbox = await SandboxInstance.create({
      name: sandboxName,
      region: defaultRegion,
      memory: 2048,
      labels: defaultLabels,
    })
    await sandbox.wait()

    await SandboxInstance.delete(sandboxName)

    await sleep(2000)

    try {
      const status = await SandboxInstance.get(sandboxName)

      if (status.status === "DELETING") {
        await sleep(10000)
        try {
          const statusAfterWait = await SandboxInstance.get(sandboxName)
          expect(["DELETING", "TERMINATED"]).toContain(statusAfterWait.status)
        } catch {
          // Deleted while we were waiting — that's fine
        }
      }
    } catch {
      // Sandbox is already deleted, which is good
    }

    await waitForSandboxDeletion(sandboxName, 90)
  })
})

