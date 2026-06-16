import { SandboxInstance } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultLabels, defaultRegion, sleep, uniqueName, waitForSandboxDeployed } from './helpers.js'

/**
 * Regression test: updating sandbox metadata (labels) must NOT trigger
 * a deployment recreation. The controlplane should detect that only
 * metadata changed and skip the deployment update path.
 *
 * Root cause (fixed): ServerlessConfig.IsEqual and JobExecutionConfig.IsEqual
 * compared *int pointer addresses instead of values, causing any sandbox with
 * non-nil Timeout/MaxScale/MinScale/MaxRetries to always fail the equality
 * check on update — even when nothing deployment-relevant changed.
 */
describe('Sandbox label update does not recreate', () => {
  const createdSandboxes: string[] = []

  afterAll(async () => {
    await Promise.all(
      createdSandboxes.map(async (name) => {
        try {
          await SandboxInstance.delete(name)
        } catch {
          // Ignore cleanup errors
        }
      })
    )
  })

  it('should not recreate sandbox when only labels are updated', async () => {
    const name = uniqueName("label-no-recreate")

    // Create a sandbox with a TTL set (non-nil pointer field in backend)
    const sandbox = await SandboxInstance.create({
      name,
      region: defaultRegion,
      labels: { ...defaultLabels, version: "1.0.0" },
      ttl: "7d",
    })
    createdSandboxes.push(name)

    // Wait for the sandbox to be fully deployed
    const deployed = await waitForSandboxDeployed(name, 60)
    expect(deployed).toBe(true)

    // Record the event count and status after initial deployment
    const beforeUpdate = await SandboxInstance.get(name)
    const eventCountBefore = beforeUpdate.events?.length ?? 0
    expect(beforeUpdate.status).toBe("DEPLOYED")

    // Update only the labels (metadata-only change)
    await SandboxInstance.updateMetadata(name, {
      labels: { ...defaultLabels, version: "2.0.0", "updated-at": new Date().toISOString() }
    })

    // Wait a few seconds for any async deployment processing
    await sleep(5000)

    // Verify the sandbox was NOT recreated
    const afterUpdate = await SandboxInstance.get(name)

    // Status should still be DEPLOYED (not DEPLOYING or CREATED)
    expect(afterUpdate.status).toBe("DEPLOYED")

    // No new deployment events should have been added
    const eventCountAfter = afterUpdate.events?.length ?? 0
    expect(eventCountAfter).toBe(eventCountBefore)

    // Verify the label was actually updated
    expect(afterUpdate.metadata.labels?.["version"]).toBe("2.0.0")
    expect(afterUpdate.metadata.labels?.["updated-at"]).toBeDefined()
  }, 120_000)

  it('should not recreate sandbox when updating labels multiple times', async () => {
    const name = uniqueName("label-multi-update")

    const sandbox = await SandboxInstance.create({
      name,
      region: defaultRegion,
      labels: { ...defaultLabels, iteration: "0" },
      ttl: "7d",
    })
    createdSandboxes.push(name)

    const deployed = await waitForSandboxDeployed(name, 60)
    expect(deployed).toBe(true)

    const beforeUpdate = await SandboxInstance.get(name)
    const eventCountBefore = beforeUpdate.events?.length ?? 0

    // Perform multiple label-only updates in sequence
    for (let i = 1; i <= 3; i++) {
      await SandboxInstance.updateMetadata(name, {
        labels: { ...defaultLabels, iteration: String(i) }
      })
      await sleep(2000)
    }

    // Wait for any async processing to complete
    await sleep(5000)

    const afterUpdates = await SandboxInstance.get(name)

    // Status must still be DEPLOYED
    expect(afterUpdates.status).toBe("DEPLOYED")

    // No new deployment events
    const eventCountAfter = afterUpdates.events?.length ?? 0
    expect(eventCountAfter).toBe(eventCountBefore)

    // Latest label value persisted
    expect(afterUpdates.metadata.labels?.["iteration"]).toBe("3")
  }, 120_000)
})
