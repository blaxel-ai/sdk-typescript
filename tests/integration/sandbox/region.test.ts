import { SandboxInstance, VolumeInstance, CodeInterpreter } from "@blaxel/core"
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName, waitForSandboxDeletion, waitForVolumeDeletion } from './helpers.js'

describe('BL_REGION Environment Variable Auto-Fill', () => {
  const createdSandboxes: string[] = []
  const createdVolumes: string[] = []
  const originalRegion = process.env.BL_REGION

  beforeEach(() => {
    // Reset BL_REGION before each test
    if (originalRegion !== undefined) {
      process.env.BL_REGION = originalRegion
    } else {
      delete process.env.BL_REGION
    }
  })

  afterAll(async () => {
    // Restore original BL_REGION value
    if (originalRegion !== undefined) {
      process.env.BL_REGION = originalRegion
    } else {
      delete process.env.BL_REGION
    }

    // Clean up all sandboxes in parallel
    await Promise.all(
      createdSandboxes.map(async (name) => {
        try {
          await SandboxInstance.delete(name)
          await waitForSandboxDeletion(name)
        } catch {
          // Ignore cleanup errors
        }
      })
    )

    // Clean up volumes in parallel
    await Promise.all(
      createdVolumes.map(async (name) => {
        try {
          await VolumeInstance.delete(name)
          await waitForVolumeDeletion(name)
        } catch {
          // Ignore cleanup errors
        }
      })
    )
  })

  describe('Sandbox creation with BL_REGION', () => {
    it('creates sandbox with backend default region when BL_REGION is not set', async () => {
      delete process.env.BL_REGION

      const name = uniqueName("no-env-region")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        labels: defaultLabels,
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata.name).toBe(name)
      // Backend should assign default region based on environment
      // prod -> us-pdx-1, dev -> eu-dub-1
      expect(sandbox.spec.region).toBe(defaultRegion)
    })

    it('creates sandbox with BL_REGION when environment variable is set', async () => {
      const testRegion = process.env.BL_ENV === "dev" ? "eu-dub-1" : "us-was-1"
      process.env.BL_REGION = testRegion

      const name = uniqueName("with-env-region")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        labels: defaultLabels,
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata.name).toBe(name)
      expect(sandbox.spec.region).toBe(testRegion)
    })

    it('explicit region takes precedence over BL_REGION', async () => {
      process.env.BL_REGION = process.env.BL_ENV === "dev" ? "eu-dub-2" : "us-was-1"
      const explicitRegion = defaultRegion

      const name = uniqueName("explicit-region")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        region: explicitRegion,
        labels: defaultLabels,
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata.name).toBe(name)
      expect(sandbox.spec.region).toBe(explicitRegion)
      expect(sandbox.spec.region).not.toBe(process.env.BL_REGION)
    })

    it('empty string region does not override BL_REGION', async () => {
      process.env.BL_REGION = process.env.BL_ENV === "dev" ? "eu-dub-1" : "us-was-1"

      const name = uniqueName("empty-region")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        region: "",
        labels: defaultLabels,
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata.name).toBe(name)
      // Empty string should be treated as "not set", so BL_REGION should be used
      expect(sandbox.spec.region).toBe(process.env.BL_REGION)
    })
  })

  describe('CodeInterpreter creation with BL_REGION', () => {
    it('creates CodeInterpreter with backend default region when BL_REGION is not set', async () => {
      delete process.env.BL_REGION

      const name = uniqueName("interpreter-no-env")
      const interpreter = await CodeInterpreter.create({
        name,
      })
      createdSandboxes.push(name)

      expect(interpreter.metadata.name).toBe(name)
      // Backend should assign default region based on environment
      expect(interpreter.spec.region).toBe(defaultRegion)
    })

    it('creates CodeInterpreter with BL_REGION when environment variable is set', async () => {
      const testRegion = process.env.BL_ENV === "dev" ? "eu-dub-1" : "us-was-1"
      process.env.BL_REGION = testRegion

      const name = uniqueName("interpreter-with-env")
      const interpreter = await CodeInterpreter.create({
        name,
      })
      createdSandboxes.push(name)

      expect(interpreter.metadata.name).toBe(name)
      expect(interpreter.spec.region).toBe(testRegion)
    })

    it('explicit region takes precedence over BL_REGION in CodeInterpreter', async () => {
      process.env.BL_REGION = process.env.BL_ENV === "dev" ? "eu-dub-2" : "us-was-1"
      const explicitRegion = defaultRegion

      const name = uniqueName("interpreter-explicit")
      const interpreter = await CodeInterpreter.create({
        name,
        region: explicitRegion,
      })
      createdSandboxes.push(name)

      expect(interpreter.metadata.name).toBe(name)
      expect(interpreter.spec.region).toBe(explicitRegion)
      expect(interpreter.spec.region).not.toBe(process.env.BL_REGION)
    })
  })

  describe('Volume creation with BL_REGION', () => {
    it('creates volume with backend default region when BL_REGION is not set', async () => {
      delete process.env.BL_REGION

      const name = uniqueName("vol-no-env")
      const volume = await VolumeInstance.create({
        name,
        size: 1024,
        labels: defaultLabels,
      })
      createdVolumes.push(name)

      expect(volume.name).toBe(name)
      // Backend should assign default region based on environment
      expect(volume.spec.region).toBe(defaultRegion)
    })

    it('creates volume with BL_REGION when environment variable is set', async () => {
      const testRegion = process.env.BL_ENV === "dev" ? "eu-dub-1" : "us-was-1"
      process.env.BL_REGION = testRegion

      const name = uniqueName("vol-with-env")
      const volume = await VolumeInstance.create({
        name,
        size: 1024,
        labels: defaultLabels,
      })
      createdVolumes.push(name)

      expect(volume.name).toBe(name)
      expect(volume.spec.region).toBe(testRegion)
    })

    it('explicit region takes precedence over BL_REGION in volume', async () => {
      process.env.BL_REGION = process.env.BL_ENV === "dev" ? "eu-dub-2" : "us-was-1"
      const explicitRegion = defaultRegion

      const name = uniqueName("vol-explicit")
      const volume = await VolumeInstance.create({
        name,
        size: 1024,
        region: explicitRegion,
        labels: defaultLabels,
      })
      createdVolumes.push(name)

      expect(volume.name).toBe(name)
      expect(volume.spec.region).toBe(explicitRegion)
      expect(volume.spec.region).not.toBe(process.env.BL_REGION)
    })

    it('empty string region does not override BL_REGION in volume', async () => {
      process.env.BL_REGION = process.env.BL_ENV === "dev" ? "eu-dub-1" : "us-was-1"

      const name = uniqueName("vol-empty-region")
      const volume = await VolumeInstance.create({
        name,
        size: 1024,
        region: "",
        labels: defaultLabels,
      })
      createdVolumes.push(name)

      expect(volume.name).toBe(name)
      // Empty string should be treated as "not set", so BL_REGION should be used
      expect(volume.spec.region).toBe(process.env.BL_REGION)
    })
  })

  describe('Multiple resource creation with BL_REGION', () => {
    it('creates sandbox and volume in same region from BL_REGION', async () => {
      const testRegion = process.env.BL_ENV === "dev" ? "eu-dub-1" : "us-was-1"
      process.env.BL_REGION = testRegion

      const volumeName = uniqueName("multi-vol")
      const sandboxName = uniqueName("multi-sandbox")

      const volume = await VolumeInstance.create({
        name: volumeName,
        size: 1024,
        labels: defaultLabels,
      })
      createdVolumes.push(volumeName)

      const sandbox = await SandboxInstance.create({
        name: sandboxName,
        image: defaultImage,
        volumes: [
          {
            name: volumeName,
            mountPath: "/data",
            readOnly: false,
          }
        ],
        labels: defaultLabels,
      })
      createdSandboxes.push(sandboxName)

      expect(volume.spec.region).toBe(testRegion)
      expect(sandbox.spec.region).toBe(testRegion)
      expect(volume.spec.region).toBe(sandbox.spec.region)

      // Verify volume is accessible in sandbox
      const result = await sandbox.process.exec({
        command: "echo 'test' > /data/test.txt && cat /data/test.txt",
        waitForCompletion: true
      })
      expect(result.logs).toContain("test")
    })

    it('handles mixed explicit and auto-filled regions', async () => {
      process.env.BL_REGION = process.env.BL_ENV === "dev" ? "eu-dub-1" : "us-was-1"
      const explicitRegion = defaultRegion

      const volume1Name = uniqueName("mixed-vol1")
      const volume2Name = uniqueName("mixed-vol2")

      // Volume 1: auto-filled from BL_REGION
      const volume1 = await VolumeInstance.create({
        name: volume1Name,
        size: 1024,
        labels: defaultLabels,
      })
      createdVolumes.push(volume1Name)

      // Volume 2: explicit region
      const volume2 = await VolumeInstance.create({
        name: volume2Name,
        size: 1024,
        region: explicitRegion,
        labels: defaultLabels,
      })
      createdVolumes.push(volume2Name)

      expect(volume1.spec.region).toBe(defaultRegion)
      expect(volume2.spec.region).toBe(explicitRegion)
    })
  })

  describe('BL_REGION changes during runtime', () => {
    it('respects BL_REGION changes between create calls', async () => {
      // Create first resource with region1
      process.env.BL_REGION = process.env.BL_ENV === "dev" ? "eu-dub-1" : "us-was-1"
      const name1 = uniqueName("region1")
      const sandbox1 = await SandboxInstance.create({
        name: name1,
        image: defaultImage,
        labels: defaultLabels,
      })
      createdSandboxes.push(name1)

      expect(sandbox1.spec.region).toBe(defaultRegion)

      // Change BL_REGION and create second resource
      process.env.BL_REGION = process.env.BL_ENV === "dev" ? "eu-dub-2" : "us-was-1"
      const name2 = uniqueName("region2")
      const sandbox2 = await SandboxInstance.create({
        name: name2,
        image: defaultImage,
        labels: defaultLabels,
      })
      createdSandboxes.push(name2)

      expect(sandbox2.spec.region).toBe(defaultRegion)

      // Verify both sandboxes have different regions
      expect(sandbox1.spec.region).not.toBe(process.env.BL_REGION)
    })
  })
})
