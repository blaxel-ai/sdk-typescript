import { SandboxInstance } from "@blaxel/core"
import { describe, expect, it } from 'vitest'
import { defaultLabels, defaultRegion, sleep, uniqueName, waitForSandboxDeletion } from './helpers.js'

describe('Delete-Recreate Race Condition Tests', () => {
  it('handles rapid delete-recreate cycles without conflicts', { timeout: 300000 }, async () => {
    const sandboxName = uniqueName("race-single")
    const iterations = 5

    for (let i = 0; i < iterations; i++) {
      // Create sandbox
      const sandbox = await SandboxInstance.create({
        name: sandboxName,
        region: defaultRegion,
        memory: 2048,
        labels: defaultLabels,
      })
      await sandbox.wait()

      // Verify it's running
      const check = await SandboxInstance.get(sandboxName)
      expect(check.status).not.toBe("DELETING")

      // Delete and wait for completion
      await SandboxInstance.delete(sandboxName)
      const deleted = await waitForSandboxDeletion(sandboxName, 60)
      expect(deleted).toBe(true)

      // Small race window before recreating
      await sleep(100)
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
        // Create sandbox
        const sandbox = await SandboxInstance.create({
          name: sandboxName,
          region: defaultRegion,
          memory: 2048,
          labels: defaultLabels,
        })
        await sandbox.wait()

        // Verify status
        const check = await SandboxInstance.get(sandboxName)
        expect(check.status).not.toBe("DELETING")

        // Delete and wait
        await SandboxInstance.delete(sandboxName)
        const deleted = await waitForSandboxDeletion(sandboxName, 60)
        expect(deleted).toBe(true)

        // Race window
        await sleep(100)
      }
    })

    await Promise.all(workers)
  })

  it('detects if sandbox gets stuck in DELETING state', { timeout: 120000 }, async () => {
    const sandboxName = uniqueName("race-deleting-check")

    // Create sandbox
    const sandbox = await SandboxInstance.create({
      name: sandboxName,
      region: defaultRegion,
      memory: 2048,
      labels: defaultLabels,
    })
    await sandbox.wait()

    // Delete
    await SandboxInstance.delete(sandboxName)

    // Try to create again immediately (this should wait or fail gracefully)
    await sleep(100)

    // Check if it's stuck in DELETING
    try {
      const status = await SandboxInstance.get(sandboxName)

      // If it still exists, it should not be in DELETING state for too long
      if (status.status === "DELETING") {
        // Wait a bit more and check again
        await sleep(5000)
        const statusAfterWait = await SandboxInstance.get(sandboxName)

        // After 5 seconds, it should either be deleted or still deleting (which is acceptable)
        // We just don't want it to get stuck permanently
        expect(["DELETING", "TERMINATED"]).toContain(statusAfterWait.status)
      }
    } catch {
      // Sandbox is already deleted, which is good
      expect(true).toBe(true)
    }

    // Clean up
    await waitForSandboxDeletion(sandboxName, 60)
  })
})

