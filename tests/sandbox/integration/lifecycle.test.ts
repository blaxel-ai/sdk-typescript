import { describe, it, expect, afterAll } from 'vitest'
import { SandboxInstance } from "@blaxel/core"
import { uniqueName, defaultImage, sleep } from './helpers'

describe('Sandbox Lifecycle and Expiration', () => {
  const createdSandboxes: string[] = []

  afterAll(async () => {
    // Clean up all sandboxes in parallel
    await Promise.all(
      createdSandboxes.map(async (name) => {
        try {
          await SandboxInstance.delete(name)
        } catch {
          // Ignore
        }
      })
    )
  })

  describe('TTL (time-to-live)', () => {
    it('creates sandbox with TTL string', async () => {
      const name = uniqueName("ttl-string")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        ttl: "5m"
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata?.name).toBe(name)

      await sleep(2000)

      // Verify sandbox is running
      const status = await SandboxInstance.get(name)
      expect(status.status).not.toBe("TERMINATED")
    })

    it('creates sandbox with expires date', async () => {
      const name = uniqueName("expires-date")
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000) // 5 minutes from now

      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        expires: expiresAt
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata?.name).toBe(name)
    })
  })

  describe('expiration policies', () => {
    it('creates sandbox with ttl-max-age policy', async () => {
      const name = uniqueName("maxage-policy")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        lifecycle: {
          expirationPolicies: [
            { type: "ttl-max-age", value: "10m", action: "delete" }
          ]
        }
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata?.name).toBe(name)
    })

    it('creates sandbox with date expiration policy', async () => {
      const name = uniqueName("date-policy")
      const expirationDate = new Date(Date.now() + 10 * 60 * 1000)

      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        lifecycle: {
          expirationPolicies: [
            { type: "date", value: expirationDate.toISOString(), action: "delete" }
          ]
        }
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata?.name).toBe(name)
    })

    it('creates sandbox with ttl-idle policy', async () => {
      const name = uniqueName("idle-policy")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        lifecycle: {
          expirationPolicies: [
            { type: "ttl-idle", value: "5m", action: "delete" }
          ]
        }
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata?.name).toBe(name)
    })

    it('creates sandbox with multiple policies', async () => {
      const name = uniqueName("multi-policy")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        lifecycle: {
          expirationPolicies: [
            { type: "ttl-idle", value: "5m", action: "delete" },
            { type: "ttl-max-age", value: "30m", action: "delete" }
          ]
        }
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata?.name).toBe(name)
    })

    it('supports various duration formats', async () => {
      const durations = ["30s", "5m", "1h"]

      for (const duration of durations) {
        const name = uniqueName(`dur-${duration.replace(/\D/g, '')}`)
        const sandbox = await SandboxInstance.create({
          name,
          image: defaultImage,
          lifecycle: {
            expirationPolicies: [
              { type: "ttl-max-age", value: duration, action: "delete" }
            ]
          }
        })
        createdSandboxes.push(name)

        expect(sandbox.metadata?.name).toBe(name)
      }
    })
  })

  describe('TTL expiration behavior', { timeout: 180000 }, () => {
    it('sandbox terminates after TTL expires', async () => {
      const name = uniqueName("ttl-expire")
      await SandboxInstance.create({
        name,
        image: defaultImage,
        ttl: "5s"
      })
      // Don't add to createdSandboxes - we expect it to auto-delete

      // Wait for TTL + buffer (cron runs every minute)
      await sleep(5100)

      // This should not fail
      await SandboxInstance.create({name})
    })
  })

  describe('snapshot configuration', () => {
    it('creates sandbox with snapshots enabled', async () => {
      const name = uniqueName("snapshot-on")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        snapshotEnabled: true
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata?.name).toBe(name)
    })

    it('creates sandbox with snapshots disabled', async () => {
      const name = uniqueName("snapshot-off")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        snapshotEnabled: false
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata?.name).toBe(name)
    })
  })
})
