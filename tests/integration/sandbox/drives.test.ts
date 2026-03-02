import { DriveInstance, SandboxInstance } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName, waitForSandboxDeletion } from './helpers.js'

describe('Drive Operations', () => {
  const createdSandboxes: string[] = []
  const createdDrives: string[] = []

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

    // Clean up drives in parallel (now safe since sandboxes are fully deleted)
    await Promise.all(
      createdDrives.map(async (name) => {
        try {
          await DriveInstance.delete(name)
        } catch {
          // Ignore
        }
      })
    )
  })

  describe('DriveInstance CRUD', () => {
    it('creates a drive', async () => {
      const name = uniqueName("drive")
      const drive = await DriveInstance.create({
        name,
        size: 10, // 10GB
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdDrives.push(name)

      expect(drive.name).toBe(name)
      expect(drive.size).toBe(10)
      expect(drive.region).toBe(defaultRegion)
    })

    it('creates a drive with display name', async () => {
      const name = uniqueName("drive-display")
      const drive = await DriveInstance.create({
        name,
        displayName: "My Test Drive",
        size: 20,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdDrives.push(name)

      expect(drive.metadata.displayName).toBe("My Test Drive")
    })

    it('gets a drive', async () => {
      const name = uniqueName("drive-get")
      await DriveInstance.create({
        name,
        size: 10,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdDrives.push(name)

      const drive = await DriveInstance.get(name)
      expect(drive.name).toBe(name)
    })

    it('lists drives', async () => {
      const name = uniqueName("drive-list")
      await DriveInstance.create({
        name,
        size: 10,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdDrives.push(name)

      const drives = await DriveInstance.list()
      expect(Array.isArray(drives)).toBe(true)

      const found = drives.find(d => d.name === name)
      expect(found).toBeDefined()
    })

    it('updates a drive', async () => {
      const name = uniqueName("drive-update")
      const drive = await DriveInstance.create({
        name,
        displayName: "Original Name",
        size: 10,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdDrives.push(name)

      const updated = await drive.update({
        displayName: "Updated Name",
        labels: {
          ...defaultLabels,
          updated: "true"
        }
      })

      expect(updated.displayName).toBe("Updated Name")
      expect(updated.metadata.labels?.updated).toBe("true")
    })

    it('deletes a drive', async () => {
      const name = uniqueName("drive-delete")
      const drive = await DriveInstance.create({
        name,
        size: 10,
        region: defaultRegion,
        labels: defaultLabels,
      })
      await drive.delete()

      // Drive should no longer exist
      await expect(DriveInstance.get(name)).rejects.toThrow()
    })

    it('creates drive if not exists', async () => {
      const name = uniqueName("drive-idempotent")
      
      // Create the first time
      const drive1 = await DriveInstance.createIfNotExists({
        name,
        size: 10,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdDrives.push(name)

      // Create again - should return existing drive
      const drive2 = await DriveInstance.createIfNotExists({
        name,
        size: 10,
        region: defaultRegion,
      })

      expect(drive1.name).toBe(drive2.name)
    })
  })

  describe('Sandbox Drive Mounting', () => {
    it('mounts a drive to a sandbox', async () => {
      const driveName = uniqueName("mount-drive")
      const sandboxName = uniqueName("mount-sandbox")

      // Create drive
      await DriveInstance.create({
        name: driveName,
        size: 10,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdDrives.push(driveName)

      // Create sandbox
      const sandbox = await SandboxInstance.create({
        name: sandboxName,
        image: defaultImage,
        memory: 2048,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdSandboxes.push(sandboxName)

      // Mount drive
      const result = await sandbox.drives.mount({
        driveName,
        mountPath: "/mnt/test",
        drivePath: "/"
      })

      expect(result.success).toBe(true)
      expect(result.driveName).toBe(driveName)
      expect(result.mountPath).toBe("/mnt/test")
    })

    it('lists mounted drives', async () => {
      const driveName = uniqueName("list-drive")
      const sandboxName = uniqueName("list-sandbox")

      await DriveInstance.create({
        name: driveName,
        size: 10,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdDrives.push(driveName)

      const sandbox = await SandboxInstance.create({
        name: sandboxName,
        image: defaultImage,
        memory: 2048,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdSandboxes.push(sandboxName)

      // Mount drive
      await sandbox.drives.mount({
        driveName,
        mountPath: "/mnt/data",
      })

      // List mounts
      const mounts = await sandbox.drives.list()
      expect(Array.isArray(mounts)).toBe(true)

      const found = mounts.find(m => m.driveName === driveName)
      expect(found).toBeDefined()
      expect(found?.mountPath).toBe("/mnt/data")
      expect(found?.drivePath).toBe("/")
    })

    it('writes and reads from mounted drive', async () => {
      const driveName = uniqueName("rw-drive")
      const sandboxName = uniqueName("rw-sandbox")

      await DriveInstance.create({
        name: driveName,
        size: 10,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdDrives.push(driveName)

      const sandbox = await SandboxInstance.create({
        name: sandboxName,
        image: defaultImage,
        memory: 2048,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdSandboxes.push(sandboxName)

      // Mount drive
      await sandbox.drives.mount({
        driveName,
        mountPath: "/mnt/storage",
      })

      // Write to the drive
      await sandbox.process.exec({
        command: "echo 'Hello from Drive' > /mnt/storage/test.txt",
        waitForCompletion: true
      })

      // Read from the drive
      const result = await sandbox.process.exec({
        command: "cat /mnt/storage/test.txt",
        waitForCompletion: true
      })

      expect(result.logs).toContain("Hello from Drive")
    })

    it('unmounts a drive from sandbox', async () => {
      const driveName = uniqueName("unmount-drive")
      const sandboxName = uniqueName("unmount-sandbox")

      await DriveInstance.create({
        name: driveName,
        size: 10,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdDrives.push(driveName)

      const sandbox = await SandboxInstance.create({
        name: sandboxName,
        image: defaultImage,
        memory: 2048,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdSandboxes.push(sandboxName)

      // Mount drive
      await sandbox.drives.mount({
        driveName,
        mountPath: "/mnt/temp",
      })

      // Verify it's mounted
      const mountsBefore = await sandbox.drives.list()
      const foundBefore = mountsBefore.find(m => m.driveName === driveName)
      expect(foundBefore).toBeDefined()

      // Unmount drive
      const unmountResult = await sandbox.drives.unmount("/mnt/temp")
      expect(unmountResult.success).toBe(true)
      expect(unmountResult.mountPath).toBe("/mnt/temp")

      // Verify it's unmounted
      const mountsAfter = await sandbox.drives.list()
      const foundAfter = mountsAfter.find(m => m.driveName === driveName)
      expect(foundAfter).toBeUndefined()
    })

    it('mounts drive subdirectory', async () => {
      const driveName = uniqueName("subdir-drive")
      const sandboxName = uniqueName("subdir-sandbox")

      await DriveInstance.create({
        name: driveName,
        size: 10,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdDrives.push(driveName)

      const sandbox = await SandboxInstance.create({
        name: sandboxName,
        image: defaultImage,
        memory: 2048,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdSandboxes.push(sandboxName)

      // First, mount the root and create a subdirectory
      await sandbox.drives.mount({
        driveName,
        mountPath: "/mnt/root",
      })

      await sandbox.process.exec({
        command: "mkdir -p /mnt/root/subdir && echo 'data in subdir' > /mnt/root/subdir/file.txt",
        waitForCompletion: true
      })

      await sandbox.drives.unmount("/mnt/root")

      // Now mount only the subdirectory
      const mountResult = await sandbox.drives.mount({
        driveName,
        mountPath: "/mnt/sub",
        drivePath: "/subdir"
      })

      expect(mountResult.drivePath).toBe("/subdir")

      // Verify we can access the file from the subdirectory mount
      const result = await sandbox.process.exec({
        command: "cat /mnt/sub/file.txt",
        waitForCompletion: true
      })

      expect(result.logs).toContain("data in subdir")
    })
  })

  describe('Drive persistence across sandboxes', () => {
    it('data persists when drive is mounted to different sandboxes', async () => {
      const driveName = uniqueName("persist-drive")
      const fileContent = "persistent data " + Date.now()

      await DriveInstance.create({
        name: driveName,
        size: 10,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdDrives.push(driveName)

      // First sandbox - write data
      const sandbox1Name = uniqueName("persist-1")
      const sandbox1 = await SandboxInstance.create({
        name: sandbox1Name,
        image: defaultImage,
        memory: 2048,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdSandboxes.push(sandbox1Name)

      await sandbox1.drives.mount({
        driveName,
        mountPath: "/data",
      })

      await sandbox1.process.exec({
        command: `echo '${fileContent}' > /data/persistent.txt`,
        waitForCompletion: true
      })

      await sandbox1.drives.unmount("/data")

      // Delete first sandbox
      await SandboxInstance.delete(sandbox1Name)
      await waitForSandboxDeletion(sandbox1Name)

      // Second sandbox - read data
      const sandbox2Name = uniqueName("persist-2")
      const sandbox2 = await SandboxInstance.create({
        name: sandbox2Name,
        image: defaultImage,
        memory: 2048,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdSandboxes.push(sandbox2Name)

      await sandbox2.drives.mount({
        driveName,
        mountPath: "/data",
      })

      const result = await sandbox2.process.exec({
        command: "cat /data/persistent.txt",
        waitForCompletion: true
      })

      expect(result.logs?.trim()).toBe(fileContent)
    })
  })

  describe('Multiple drives', () => {
    it('mounts multiple drives to a sandbox', async () => {
      const drive1Name = uniqueName("multi-drive1")
      const drive2Name = uniqueName("multi-drive2")
      const sandboxName = uniqueName("multi-sandbox")

      await DriveInstance.create({
        name: drive1Name,
        size: 5,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdDrives.push(drive1Name)

      await DriveInstance.create({
        name: drive2Name,
        size: 5,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdDrives.push(drive2Name)

      const sandbox = await SandboxInstance.create({
        name: sandboxName,
        image: defaultImage,
        memory: 2048,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdSandboxes.push(sandboxName)

      // Mount both drives
      await sandbox.drives.mount({
        driveName: drive1Name,
        mountPath: "/mnt/drive1",
      })

      await sandbox.drives.mount({
        driveName: drive2Name,
        mountPath: "/mnt/drive2",
      })

      // Verify both are mounted
      const mounts = await sandbox.drives.list()
      expect(mounts.length).toBeGreaterThanOrEqual(2)

      const found1 = mounts.find(m => m.driveName === drive1Name)
      const found2 = mounts.find(m => m.driveName === drive2Name)
      expect(found1).toBeDefined()
      expect(found2).toBeDefined()

      // Write to both drives
      await sandbox.process.exec({
        command: "echo 'drive1 data' > /mnt/drive1/file.txt && echo 'drive2 data' > /mnt/drive2/file.txt",
        waitForCompletion: true
      })

      // Read from both
      const result1 = await sandbox.process.exec({
        command: "cat /mnt/drive1/file.txt",
        waitForCompletion: true
      })
      expect(result1.logs).toContain("drive1 data")

      const result2 = await sandbox.process.exec({
        command: "cat /mnt/drive2/file.txt",
        waitForCompletion: true
      })
      expect(result2.logs).toContain("drive2 data")
    })
  })

  describe('Drive mount path handling', () => {
    it('handles mount path without leading slash', async () => {
      const driveName = uniqueName("path-drive")
      const sandboxName = uniqueName("path-sandbox")

      await DriveInstance.create({
        name: driveName,
        size: 10,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdDrives.push(driveName)

      const sandbox = await SandboxInstance.create({
        name: sandboxName,
        image: defaultImage,
        memory: 2048,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdSandboxes.push(sandboxName)

      // Mount with path without leading slash - should still work
      const result = await sandbox.drives.mount({
        driveName,
        mountPath: "/mnt/test",
      })

      expect(result.success).toBe(true)

      // Unmount should also work without leading slash
      await sandbox.drives.unmount("mnt/test")

      const mounts = await sandbox.drives.list()
      const found = mounts.find(m => m.driveName === driveName)
      expect(found).toBeUndefined()
    })
  })

  describe('Drive file operations', () => {
    it('creates directory structure in drive', async () => {
      const driveName = uniqueName("fs-drive")
      const sandboxName = uniqueName("fs-sandbox")

      await DriveInstance.create({
        name: driveName,
        size: 10,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdDrives.push(driveName)

      const sandbox = await SandboxInstance.create({
        name: sandboxName,
        image: defaultImage,
        memory: 2048,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdSandboxes.push(sandboxName)

      await sandbox.drives.mount({
        driveName,
        mountPath: "/mnt/files",
      })

      // Create directory structure (POSIX mkdir - no brace expansion; /bin/sh may be dash/ash)
      await sandbox.process.exec({
        command: "mkdir -p /mnt/files/project/src /mnt/files/project/tests /mnt/files/project/docs && echo 'code' > /mnt/files/project/src/main.js",
        waitForCompletion: true
      })

      // Verify structure
      const result = await sandbox.process.exec({
        command: "ls -la /mnt/files/project/",
        waitForCompletion: true
      })

      expect(result.logs).toContain("src")
      expect(result.logs).toContain("tests")
      expect(result.logs).toContain("docs")

      // Verify file content
      const catResult = await sandbox.process.exec({
        command: "cat /mnt/files/project/src/main.js",
        waitForCompletion: true
      })
      expect(catResult.logs).toContain("code")
    })

    it('uses filesystem API with mounted drive', async () => {
      const driveName = uniqueName("fsapi-drive")
      const sandboxName = uniqueName("fsapi-sandbox")

      await DriveInstance.create({
        name: driveName,
        size: 10,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdDrives.push(driveName)

      const sandbox = await SandboxInstance.create({
        name: sandboxName,
        image: defaultImage,
        memory: 2048,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdSandboxes.push(sandboxName)

      await sandbox.drives.mount({
        driveName,
        mountPath: "/mnt/fs",
      })

      // Use filesystem API to write
      await sandbox.fs.write("/mnt/fs/api-test.txt", "Written via FS API")

      // Read back
      const content = await sandbox.fs.read("/mnt/fs/api-test.txt")
      expect(content).toBe("Written via FS API")
    })
  })
})
