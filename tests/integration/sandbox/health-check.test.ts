import { SandboxInstance, settings } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName } from './helpers.js'

describe('Sandbox Health Check', () => {
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

  it('health endpoint is immediately available after creation', async () => {
    const name = uniqueName("health")

    const sandbox = await SandboxInstance.create({
      name,
      image: defaultImage,
      memory: 4096,
      region: defaultRegion,
      labels: defaultLabels,
    })
    createdSandboxes.push(name)

    const sandboxHost = sandbox.metadata?.url
    expect(sandboxHost).toBeDefined()

    // Make health check request immediately
    const healthResponse = await fetch(`${sandboxHost}/health`, {
      method: "GET",
      headers: {
        "Authorization": settings.authorization,
      },
    })

    expect(healthResponse.status).toBe(200)
    const healthData = await healthResponse.json()
    expect(healthData).toBeDefined()
  })

  it('health check returns valid JSON response', async () => {
    const name = uniqueName("health-json")

    const sandbox = await SandboxInstance.create({
      name,
      image: defaultImage,
      memory: 4096,
      region: defaultRegion,
      labels: defaultLabels,
    })
    createdSandboxes.push(name)

    const sandboxHost = sandbox.metadata?.url
    const healthResponse = await fetch(`${sandboxHost}/health`, {
      method: "GET",
      headers: {
        "Authorization": settings.authorization,
      },
    })

    expect(healthResponse.headers.get("content-type")).toContain("application/json")
    const data = await healthResponse.json()
    expect(typeof data).toBe("object")
  })

  it('handles parallel health checks', async () => {
    const numChecks = 3
    const names = Array.from({ length: numChecks }, () => uniqueName("health-parallel"))

    const sandboxes = await Promise.all(
      names.map((name) =>
        SandboxInstance.create({
          name,
          image: defaultImage,
          memory: 4096,
          region: defaultRegion,
          labels: defaultLabels,
        })
      )
    )
    createdSandboxes.push(...names)

    const healthChecks = sandboxes.map(async (sandbox) => {
      const sandboxHost = sandbox.metadata?.url
      const response = await fetch(`${sandboxHost}/health`, {
        method: "GET",
        headers: {
          "Authorization": settings.authorization,
        },
      })
      return response.status
    })

    const results = await Promise.all(healthChecks)
    results.forEach((status) => {
      expect(status).toBe(200)
    })
  })

  it('measures availability gap after creation', async () => {
    const name = uniqueName("health-gap")

    const createStart = Date.now()
    const sandbox = await SandboxInstance.create({
      name,
      image: defaultImage,
      memory: 4096,
      region: defaultRegion,
      labels: defaultLabels,
    })
    const createTime = Date.now() - createStart
    createdSandboxes.push(name)

    const healthStart = Date.now()
    const sandboxHost = sandbox.metadata?.url
    const healthResponse = await fetch(`${sandboxHost}/health`, {
      method: "GET",
      headers: {
        "Authorization": settings.authorization,
      },
    })
    const healthTime = Date.now() - healthStart

    expect(healthResponse.status).toBe(200)
    expect(createTime).toBeLessThan(60000) // Should complete within 60s
    expect(healthTime).toBeLessThan(5000) // Health check should be fast
  })
})

