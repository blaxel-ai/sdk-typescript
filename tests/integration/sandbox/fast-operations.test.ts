import { SandboxInstance } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, uniqueName } from './helpers.js'

describe('Fast Sandbox Operations', () => {
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

  it('creates sandbox and executes command quickly', async () => {
    const name = uniqueName("fast-op")

    const startTime = Date.now()
    const sandbox = await SandboxInstance.create({
      name,
      image: defaultImage,
      labels: defaultLabels,
    })
    const createTime = Date.now() - startTime
    createdSandboxes.push(name)

    const execStart = Date.now()
    const result = await sandbox.process.exec({
      command: "ls",
      waitForCompletion: true
    })
    const execTime = Date.now() - execStart

    expect(result).toBeDefined()
    expect(createTime).toBeLessThan(60000) // Should be under 60s
    expect(execTime).toBeLessThan(10000) // Should be under 10s
  })

  it('handles multiple rapid operations', async () => {
    const iterations = 3
    const timings: Array<{ create: number; exec: number }> = []

    for (let i = 0; i < iterations; i++) {
      const name = uniqueName("fast-multi")

      const createStart = Date.now()
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        labels: defaultLabels,
      })
      const createTime = Date.now() - createStart

      const execStart = Date.now()
      await sandbox.process.exec({ command: "echo 'test'", waitForCompletion: true })
      const execTime = Date.now() - execStart

      timings.push({ create: createTime, exec: execTime })

      // Clean up immediately
      await SandboxInstance.delete(name)
    }

    // Verify all operations completed
    expect(timings).toHaveLength(iterations)
    timings.forEach(timing => {
      expect(timing.create).toBeLessThan(60000)
      expect(timing.exec).toBeLessThan(10000)
    })
  })

  it('handles sequential create-delete cycles', async () => {
    const cycles = 3
    const name = uniqueName("fast-cycle")

    for (let i = 0; i < cycles; i++) {
      const sandbox = await SandboxInstance.create({
        name: `${name}-${i}`,
        image: defaultImage,
        labels: defaultLabels,
      })

      const result = await sandbox.process.exec({
        command: "echo 'cycle test'",
        waitForCompletion: true
      })

      expect(result.logs).toContain("cycle test")

      // Delete immediately
      await SandboxInstance.delete(`${name}-${i}`)
    }
  })
})

