import { createSandbox, SandboxInstance } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultLabels, uniqueName, waitForSandboxDeletion } from './helpers.js'

// Set to true to enable custom Docker image tests
const ENABLE_CUSTOM_DOCKER_TESTS = process.env.ENABLE_CUSTOM_DOCKER_TESTS === 'true' || false

describe('Sandbox Image Tests', () => {
  const createdSandboxes: string[] = []

  afterAll(async () => {
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
  })

  describe('without image name', () => {
    it('fails to create a sandbox without specifying an image using raw API', async () => {
      const name = uniqueName("no-image")

      // Use raw API to bypass SDK's default image logic
      // The backend should reject this because image is required
      await expect(
        createSandbox({
          body: {
            metadata: { name, labels: defaultLabels },
            spec: {
              runtime: {
                memory: 4096
                // Note: image is intentionally omitted here
              }
            }
          },
          throwOnError: true
        })
      ).rejects.toThrow()

      // Verify the sandbox was not created
      await expect(
        SandboxInstance.get(name)
      ).rejects.toThrow()
    })

    it('SDK automatically fills default image when not specified', async () => {
      const name = uniqueName("no-image-sdk")

      // When using the SDK's create method, it should automatically fill in a default image
      const sandbox = await SandboxInstance.create({
        name,
        labels: defaultLabels
        // Note: image is intentionally omitted here
      })
      createdSandboxes.push(name)

      // SDK should have filled in the default image
      expect(sandbox.spec.runtime?.image).toBeDefined()
      expect(sandbox.spec.runtime?.image).toBe("blaxel/base-image:latest")

      // Verify the sandbox is functional
      const result = await sandbox.process.exec({
        command: "echo 'testing'",
        waitForCompletion: true
      })

      expect(result.logs).toContain("testing")
    })
  })

  describe('with valid images', () => {
    it('creates a sandbox with blaxel/base-image (no tag)', async () => {
      const name = uniqueName("valid-image-no-tag")

      const sandbox = await SandboxInstance.create({
        name,
        image: "blaxel/base-image",
        labels: defaultLabels
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata.name).toBe(name)
      expect(sandbox.spec.runtime?.image).toBe("blaxel/base-image")

      // Verify the sandbox is functional
      const result = await sandbox.process.exec({
        command: "echo 'working'",
        waitForCompletion: true
      })
      expect(result.logs).toContain("working")
    })

    it('creates a sandbox with blaxel/base-image:latest', async () => {
      const name = uniqueName("valid-image-latest")

      const sandbox = await SandboxInstance.create({
        name,
        image: "blaxel/base-image:latest",
        labels: defaultLabels
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata.name).toBe(name)
      expect(sandbox.spec.runtime?.image).toBe("blaxel/base-image:latest")

      // Verify the sandbox is functional
      const result = await sandbox.process.exec({
        command: "uname -s",
        waitForCompletion: true
      })
      expect(result.logs).toBeDefined()
      expect(result.logs.length).toBeGreaterThan(0)
    })
  })

  describe('with non-existent image', () => {
    it('fails to create a sandbox with a random non-existent image', async () => {
      const name = uniqueName("bad-image")
      const randomImage = `non-existent-image-${Date.now()}:invalid-tag`

      await expect(
        SandboxInstance.create({
          name,
          image: randomImage,
          labels: defaultLabels
        })
      ).rejects.toThrow()

      // Verify the sandbox was not created
      await expect(
        SandboxInstance.get(name)
      ).rejects.toThrow()
    })

    it('fails with invalid image format', async () => {
      const name = uniqueName("invalid-format")
      const invalidImage = "not_a_valid_image_format"

      await expect(
        SandboxInstance.create({
          name,
          image: invalidImage,
          labels: defaultLabels
        })
      ).rejects.toThrow()
    })

    it('fails with non-existent registry', async () => {
      const name = uniqueName("bad-registry")
      const badRegistryImage = "fake-registry.example.com/image:latest"

      await expect(
        SandboxInstance.create({
          name,
          image: badRegistryImage,
          labels: defaultLabels
        })
      ).rejects.toThrow()
    })

    it('fails with blaxel/base-image:notexistingtag', async () => {
      const name = uniqueName("bad-tag")
      const invalidTagImage = "blaxel/base-image:notexistingtag"

      await expect(
        SandboxInstance.create({
          name,
          image: invalidTagImage,
          labels: defaultLabels
        })
      ).rejects.toThrow()

      // Verify the sandbox was not created
      await expect(
        SandboxInstance.get(name)
      ).rejects.toThrow()
    })
  })

  describe.skipIf(!ENABLE_CUSTOM_DOCKER_TESTS)('with custom Docker images', () => {
    it('creates a sandbox with docker (no tag)', async () => {
      const name = uniqueName("docker-no-tag")

      const sandbox = await SandboxInstance.create({
        name,
        image: "docker",
        labels: defaultLabels
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata.name).toBe(name)
      expect(sandbox.spec.runtime?.image).toBe("docker")

      // Verify the sandbox is functional
      const result = await sandbox.process.exec({
        command: "echo 'docker works'",
        waitForCompletion: true
      })
      expect(result.logs).toContain("docker works")
    })

    it('creates a sandbox with docker:latest', async () => {
      const name = uniqueName("docker-latest")

      const sandbox = await SandboxInstance.create({
        name,
        image: "docker:latest",
        labels: defaultLabels
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata.name).toBe(name)
      expect(sandbox.spec.runtime?.image).toBe("docker:latest")

      // Verify the sandbox is functional
      const result = await sandbox.process.exec({
        command: "echo 'docker latest works'",
        waitForCompletion: true
      })
      expect(result.logs).toContain("docker latest works")
    })

    it('creates a sandbox with docker:lqyszf5qx5pe', async () => {
      const name = uniqueName("docker-tag")

      const sandbox = await SandboxInstance.create({
        name,
        image: "docker:lqyszf5qx5pe",
        labels: defaultLabels
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata.name).toBe(name)
      expect(sandbox.spec.runtime?.image).toBe("docker:lqyszf5qx5pe")

      // Verify the sandbox is functional
      const result = await sandbox.process.exec({
        command: "echo 'docker tag works'",
        waitForCompletion: true
      })
      expect(result.logs).toContain("docker tag works")
    })

    it('creates a sandbox with sandbox/docker (no tag)', async () => {
      const name = uniqueName("sandbox-docker-no-tag")

      const sandbox = await SandboxInstance.create({
        name,
        image: "sandbox/docker",
        labels: defaultLabels
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata.name).toBe(name)
      expect(sandbox.spec.runtime?.image).toBe("sandbox/docker")

      // Verify the sandbox is functional
      const result = await sandbox.process.exec({
        command: "echo 'sandbox/docker works'",
        waitForCompletion: true
      })
      expect(result.logs).toContain("sandbox/docker works")
    })

    it('creates a sandbox with sandbox/docker:latest', async () => {
      const name = uniqueName("sandbox-docker-latest")

      const sandbox = await SandboxInstance.create({
        name,
        image: "sandbox/docker:latest",
        labels: defaultLabels
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata.name).toBe(name)
      expect(sandbox.spec.runtime?.image).toBe("sandbox/docker:latest")

      // Verify the sandbox is functional
      const result = await sandbox.process.exec({
        command: "echo 'sandbox/docker latest works'",
        waitForCompletion: true
      })
      expect(result.logs).toContain("sandbox/docker latest works")
    })

    it('creates a sandbox with sandbox/docker:lqyszf5qx5pe', async () => {
      const name = uniqueName("sandbox-docker-tag")

      const sandbox = await SandboxInstance.create({
        name,
        image: "sandbox/docker:lqyszf5qx5pe",
        labels: defaultLabels
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata.name).toBe(name)
      expect(sandbox.spec.runtime?.image).toBe("sandbox/docker:lqyszf5qx5pe")

      // Verify the sandbox is functional
      const result = await sandbox.process.exec({
        command: "echo 'sandbox/docker tag works'",
        waitForCompletion: true
      })
      expect(result.logs).toContain("sandbox/docker tag works")
    })
  })
})
