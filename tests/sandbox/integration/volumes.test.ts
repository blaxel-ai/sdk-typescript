import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { SandboxInstance, VolumeInstance } from "@blaxel/core"
import { uniqueName, defaultImage, defaultRegion, waitForSandboxDeletion, sleep, waitForVolumeDeletion } from './helpers'

describe('Sandbox Volume Operations', () => {
  const createdSandboxes: string[] = []
  const createdVolumes: string[] = []

  afterAll(async () => {
    // Clean up sandboxes in parallel and wait for full deletion
    await Promise.all(
      createdSandboxes.map(async (name) => {
        try {
          await SandboxInstance.delete(name)
          await waitForSandboxDeletion(name)
        } catch {
          // Ignore
        }
      })
    )

    // Clean up volumes in parallel (now safe since sandboxes are fully deleted)
    await Promise.all(
      createdVolumes.map(async (name) => {
        try {
          await VolumeInstance.delete(name)
        } catch {
          // Ignore
        }
      })
    )

  })

  describe('VolumeInstance CRUD', () => {
    it('creates a volume', async () => {
      const name = uniqueName("volume")
      const volume = await VolumeInstance.create({
        name,
        size: 1024, // 1GB
        region: defaultRegion
      })
      createdVolumes.push(name)

      expect(volume.name).toBe(name)
    })

    it('creates a volume with display name', async () => {
      const name = uniqueName("volume-display")
      const volume = await VolumeInstance.create({
        name,
        displayName: "My Test Volume",
        size: 1024,
        region: defaultRegion
      })
      createdVolumes.push(name)

      expect(volume.name).toBe(name)
    })

    it('gets a volume', async () => {
      const name = uniqueName("volume-get")
      await VolumeInstance.create({
        name,
        size: 1024,
        region: defaultRegion
      })
      createdVolumes.push(name)

      const volume = await VolumeInstance.get(name)
      expect(volume.name).toBe(name)
    })

    it('lists volumes', async () => {
      const name = uniqueName("volume-list")
      await VolumeInstance.create({
        name,
        size: 1024,
        region: defaultRegion
      })
      createdVolumes.push(name)

      const volumes = await VolumeInstance.list()
      expect(Array.isArray(volumes)).toBe(true)

      const found = volumes.find(v => v.name === name)
      expect(found).toBeDefined()
    })

    it('deletes a volume', async () => {
      const name = uniqueName("volume-delete")
      const volume = await VolumeInstance.create({
        name,
        size: 1024,
        region: defaultRegion
      })
      await volume.delete()
      await waitForVolumeDeletion(name)

      // Volume should no longer exist
      await expect(VolumeInstance.get(name)).rejects.toThrow()
    })
  })

  describe('mounting volumes to sandboxes', () => {
    it('mounts a volume to a sandbox', async () => {
      const volumeName = uniqueName("mount-vol")
      const sandboxName = uniqueName("mount-sandbox")

      await VolumeInstance.create({
        name: volumeName,
        size: 1024,
        region: defaultRegion
      })
      createdVolumes.push(volumeName)

      const sandbox = await SandboxInstance.create({
        name: sandboxName,
        image: defaultImage,
        memory: 2048,
        region: defaultRegion,
        volumes: [
          {
            name: volumeName,
            mountPath: "/data",
            readOnly: false
          }
        ]
      })
      createdSandboxes.push(sandboxName)

      // Verify mount by writing a file
      await sandbox.process.exec({
        command: "echo 'mounted' > /data/test.txt",
        waitForCompletion: true
      })

      const result = await sandbox.process.exec({
        command: "cat /data/test.txt",
        waitForCompletion: true
      })

      expect(result.logs).toContain("mounted")
    })

    // Not supported yet
    // it('mounts volume as read-only', async () => {
    //   const volumeName = uniqueName("ro-vol")
    //   const sandboxName = uniqueName("ro-sandbox")

    //   await VolumeInstance.create({
    //     name: volumeName,
    //     size: 1024,
    //     region: defaultRegion
    //   })
    //   createdVolumes.push(volumeName)

    //   // First, create a sandbox with write access to add content
    //   const writeSandbox = await SandboxInstance.create({
    //     name: uniqueName("write-sandbox"),
    //     image: defaultImage,
    //     region: defaultRegion,
    //     volumes: [{ name: volumeName, mountPath: "/data", readOnly: false }]
    //   })
    //   createdSandboxes.push(writeSandbox.metadata?.name!)
    //   await writeSandbox.wait()

    //   await writeSandbox.process.exec({
    //     command: "echo 'readonly content' > /data/readonly.txt",
    //     waitForCompletion: true
    //   })

    //   await SandboxInstance.delete(writeSandbox.metadata?.name!)
    //   await waitForSandboxDeletion(writeSandbox.metadata?.name!)

    //   // Now create read-only sandbox
    //   const sandbox = await SandboxInstance.create({
    //     name: sandboxName,
    //     image: defaultImage,
    //     region: defaultRegion,
    //     volumes: [{ name: volumeName, mountPath: "/data", readOnly: true }]
    //   })
    //   createdSandboxes.push(sandboxName)

    //   // Should be able to read
    //   const readResult = await sandbox.process.exec({
    //     command: "cat /data/readonly.txt",
    //     waitForCompletion: true
    //   })
    //   expect(readResult.logs).toContain("readonly content")

    //   // Should fail to write
    //   const writeResult = await sandbox.process.exec({
    //     command: "(echo 'new' > /data/new.txt 2>&1 && echo 'WRITE_SUCCESS') || echo 'WRITE_FAILED'",
    //     waitForCompletion: true
    //   })
    //   console.log("writeResult => ", writeResult)
    //   expect(writeResult.logs).toContain("WRITE_FAILED")
    // })
  })

  describe('volume persistence', () => {
    it('data persists across sandbox recreations', async () => {
      const volumeName = uniqueName("persist-vol")
      const fileContent = "persistent data " + Date.now()

      await VolumeInstance.create({
        name: volumeName,
        size: 1024,
        region: defaultRegion
      })
      createdVolumes.push(volumeName)

      // First sandbox - write data
      const sandbox1Name = uniqueName("persist-1")
      const sandbox1 = await SandboxInstance.create({
        name: sandbox1Name,
        image: defaultImage,
        region: defaultRegion,
        volumes: [{ name: volumeName, mountPath: "/persistent", readOnly: false }]
      })
      await sandbox1.wait()

      await sandbox1.process.exec({
        command: `echo '${fileContent}' > /persistent/data.txt`,
        waitForCompletion: true
      })

      // Delete first sandbox and wait for full deletion
      await SandboxInstance.delete(sandbox1Name)
      await waitForSandboxDeletion(sandbox1Name)

      // Second sandbox - read data
      const sandbox2Name = uniqueName("persist-2")
      const sandbox2 = await SandboxInstance.create({
        name: sandbox2Name,
        image: defaultImage,
        region: defaultRegion,
        volumes: [{ name: volumeName, mountPath: "/data", readOnly: false }]
      })
      createdSandboxes.push(sandbox2Name)
      await sandbox2.wait()

      const result = await sandbox2.process.exec({
        command: "cat /data/data.txt",
        waitForCompletion: true
      })

      expect(result.logs?.trim()).toBe(fileContent)
    })
  })

  // Not supported yet
  // describe('multiple volumes', () => {
  //   it('mounts multiple volumes to a sandbox', async () => {
  //     const vol1Name = uniqueName("multi-vol1")
  //     const vol2Name = uniqueName("multi-vol2")
  //     const sandboxName = uniqueName("multi-sandbox")

  //     await VolumeInstance.create({
  //       name: vol1Name,
  //       size: 512,
  //       region: defaultRegion
  //     })
  //     createdVolumes.push(vol1Name)

  //     await VolumeInstance.create({
  //       name: vol2Name,
  //       size: 512,
  //       region: defaultRegion
  //     })
  //     createdVolumes.push(vol2Name)

  //     const sandbox = await SandboxInstance.create({
  //       name: sandboxName,
  //       image: defaultImage,
  //       region: defaultRegion,
  //       volumes: [
  //         { name: vol1Name, mountPath: "/vol1", readOnly: false },
  //         { name: vol2Name, mountPath: "/vol2", readOnly: false }
  //       ]
  //     })
  //     createdSandboxes.push(sandboxName)

  //     // Write to both volumes
  //     await sandbox.process.exec({
  //       command: "echo 'vol1 data' > /vol1/file.txt && echo 'vol2 data' > /vol2/file.txt",
  //       waitForCompletion: true
  //     })

  //     // Read from both
  //     const result1 = await sandbox.process.exec({
  //       command: "cat /vol1/file.txt",
  //       waitForCompletion: true
  //     })
  //     expect(result1.logs).toContain("vol1 data")

  //     const result2 = await sandbox.process.exec({
  //       command: "cat /vol2/file.txt",
  //       waitForCompletion: true
  //     })
  //     expect(result2.logs).toContain("vol2 data")
  //   })
  // })
})
