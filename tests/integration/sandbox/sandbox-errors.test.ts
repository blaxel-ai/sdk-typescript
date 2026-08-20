import { SandboxInstance } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName } from './helpers.js'

// The infrastructure error history the compute plane records on a sandbox
// (controlplane#5198). A healthy sandbox has none, so what is asserted here is
// the contract of the accessor: always an array, and never carried by a listing
// (the projection drops the field, so it reads as empty too).
describe('Sandbox infrastructure errors', () => {
  const name = uniqueName("errors")
  const createdSandboxes: string[] = [name]

  afterAll(async () => {
    await Promise.all(
      createdSandboxes.map(async (sandboxName) => {
        try {
          await SandboxInstance.delete(sandboxName)
        } catch {
          // Ignore cleanup errors
        }
      })
    )
  })

  it('reads an empty error history on a healthy sandbox', async () => {
    await SandboxInstance.create({
      name,
      image: defaultImage,
      region: defaultRegion,
      labels: defaultLabels,
    })

    const sandbox = await SandboxInstance.get(name)

    // The shape of an entry (code, fatal, instance, message, time) is not
    // exercisable here: covering it would mean provoking a real infrastructure
    // failure on the compute plane.
    expect(Array.isArray(sandbox.errors)).toBe(true)
    expect(sandbox.errors).toHaveLength(0)
  })

  it('does not carry the error history in a listing', async () => {
    const page = await SandboxInstance.list({ limit: 1 })

    const listed = page.data[0]
    expect(listed).toBeDefined()
    expect(listed.errors).toEqual([])
  })
})
