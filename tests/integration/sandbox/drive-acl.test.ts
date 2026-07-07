import { DriveInstance, SandboxInstance } from "@blaxel/core"
import type { DrivePermission } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, sleep, uniqueName, waitForSandboxDeletion, isUsingMk3_1 } from './helpers.js'

const defaultRegion = process.env.BL_DRIVE_REGION || (process.env.BL_ENV !== 'dev' ? 'us-was-1' : 'eu-dub-1')
const MOUNT_SETTLE_MS = 3_000

describe.skipIf(isUsingMk3_1())('Drive ACL Permissions', () => {
  const createdSandboxes: string[] = []
  const createdDrives: string[] = []

  afterAll(async () => {
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

  describe.skipIf(isUsingMk3_1())('Drive creation with permissions', () => {
    it('creates a drive with permissions', async () => {
      const name = uniqueName("acl-create")
      const permissions: DrivePermission[] = [
        { labels: { team: "backend" }, mode: "read-write" },
      ]

      const drive = await DriveInstance.create({
        name,
        size: 1,
        region: defaultRegion,
        labels: defaultLabels,
        permissions,
      })
      createdDrives.push(name)

      expect(drive.name).toBe(name)
      expect(drive.permissions).toBeDefined()
      expect(drive.permissions).toHaveLength(1)
      expect(drive.permissions?.[0]?.labels?.team).toBe("backend")
      expect(drive.permissions?.[0]?.mode).toBe("read-write")
    })

    it('creates a drive with permissions using full Drive object', async () => {
      const name = uniqueName("acl-full")
      const permissions: DrivePermission[] = [
        { labels: { team: "infra" }, mode: "read-write" },
      ]

      const drive = await DriveInstance.create({
        metadata: {
          name,
          displayName: name,
          labels: defaultLabels,
        },
        spec: {
          size: 1,
          region: defaultRegion,
          permissions,
        },
      })
      createdDrives.push(name)

      expect(drive.name).toBe(name)
      expect(drive.permissions).toBeDefined()
      expect(drive.permissions).toHaveLength(1)
      expect(drive.permissions?.[0]?.labels?.team).toBe("infra")
      expect(drive.permissions?.[0]?.mode).toBe("read-write")
    })

    it('creates a drive with empty permissions (open access)', async () => {
      const name = uniqueName("acl-open")

      const drive = await DriveInstance.create({
        name,
        size: 1,
        region: defaultRegion,
        labels: defaultLabels,
        permissions: [],
      })
      createdDrives.push(name)

      expect(drive.name).toBe(name)
    })

    it('creates a drive with multiple permissions', async () => {
      const name = uniqueName("acl-multi")
      const permissions: DrivePermission[] = [
        { labels: { team: "alpha" }, mode: "read-write" },
        { labels: { team: "beta" }, mode: "read" },
        { labels: { role: "admin" }, mode: "read-write", path: "/" },
      ]

      const drive = await DriveInstance.create({
        name,
        size: 1,
        region: defaultRegion,
        labels: defaultLabels,
        permissions,
      })
      createdDrives.push(name)

      expect(drive.permissions).toHaveLength(3)
      expect(drive.permissions?.[1]?.mode).toBe("read")
      expect(drive.permissions?.[2]?.path).toBe("/")
    })
  })

  describe.skipIf(isUsingMk3_1())('Drive permission updates', () => {
    it('updates permissions on an existing drive', async () => {
      const name = uniqueName("acl-upd")

      await DriveInstance.create({
        name,
        size: 1,
        region: defaultRegion,
        labels: defaultLabels,
        permissions: [],
      })
      createdDrives.push(name)

      const updated = await DriveInstance.update(name, {
        permissions: [
          { labels: { team: "restricted" }, mode: "read-write" },
        ],
      })

      expect(updated.permissions).toHaveLength(1)
      expect(updated.permissions?.[0]?.labels?.team).toBe("restricted")
    })

    it('persists updated permissions on re-fetch', async () => {
      const name = uniqueName("acl-persist")

      await DriveInstance.create({
        name,
        size: 1,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdDrives.push(name)

      await DriveInstance.update(name, {
        permissions: [
          { labels: { env: "staging" }, mode: "read" },
        ],
      })

      const fetched = await DriveInstance.get(name)
      expect(fetched.permissions).toHaveLength(1)
      expect(fetched.permissions?.[0]?.labels?.env).toBe("staging")
      expect(fetched.permissions?.[0]?.mode).toBe("read")
    })
  })

  describe.skipIf(isUsingMk3_1())('Label-based access control', () => {
    it('allows matching sandbox to mount and write', async () => {
      const driveName = uniqueName("acl-allow")
      const sandboxName = uniqueName("acl-allow-sbx")

      await DriveInstance.create({
        name: driveName,
        size: 1,
        region: defaultRegion,
        labels: defaultLabels,
        permissions: [
          { labels: { team: "backend" }, mode: "read-write" },
        ],
      })
      createdDrives.push(driveName)

      const sandbox = await SandboxInstance.create({
        name: sandboxName,
        image: defaultImage,
        memory: 2048,
        region: defaultRegion,
        labels: { ...defaultLabels, team: "backend" },
      }, { safe: true })
      createdSandboxes.push(sandboxName)

      await sandbox.drives.mount({ driveName, mountPath: "/mnt/acl" })
      await sleep(MOUNT_SETTLE_MS)

      const result = await sandbox.process.exec({
        command: "echo 'acl-write-ok' > /mnt/acl/test.txt && cat /mnt/acl/test.txt",
        waitForCompletion: true,
      })

      expect(result.logs).toContain("acl-write-ok")
    })

    it('denies non-matching sandbox from mounting', async () => {
      const driveName = uniqueName("acl-deny")
      const sandboxName = uniqueName("acl-deny-sbx")

      await DriveInstance.create({
        name: driveName,
        size: 1,
        region: defaultRegion,
        labels: defaultLabels,
        permissions: [
          { labels: { team: "secret" }, mode: "read-write" },
        ],
      })
      createdDrives.push(driveName)

      const sandbox = await SandboxInstance.create({
        name: sandboxName,
        image: defaultImage,
        memory: 2048,
        region: defaultRegion,
        labels: { ...defaultLabels, team: "other" },
      }, { safe: true })
      createdSandboxes.push(sandboxName)

      try {
        await sandbox.drives.mount({ driveName, mountPath: "/mnt/acl" })
        await sleep(MOUNT_SETTLE_MS)
        const write = await sandbox.process.exec({
          command: "echo 'should-fail' > /mnt/acl/test.txt",
          waitForCompletion: true,
        })
        expect(write.logs).not.toContain("should-fail")
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        expect(
          msg.includes("timeout") || msg.includes("denied") || msg.includes("Permission") || msg.includes("exit status")
        ).toBe(true)
      }
    })

    it('open-access drive (no permissions) allows any sandbox', async () => {
      const driveName = uniqueName("acl-noprm")
      const sandboxName = uniqueName("acl-noprm-sbx")

      await DriveInstance.create({
        name: driveName,
        size: 1,
        region: defaultRegion,
        labels: defaultLabels,
        permissions: [],
      })
      createdDrives.push(driveName)

      const sandbox = await SandboxInstance.create({
        name: sandboxName,
        image: defaultImage,
        memory: 2048,
        region: defaultRegion,
        labels: { ...defaultLabels, role: "anything" },
      }, { safe: true })
      createdSandboxes.push(sandboxName)

      await sandbox.drives.mount({ driveName, mountPath: "/mnt/open" })
      await sleep(MOUNT_SETTLE_MS)

      const result = await sandbox.process.exec({
        command: "echo 'open-ok' > /mnt/open/test.txt && cat /mnt/open/test.txt",
        waitForCompletion: true,
      })

      expect(result.logs).toContain("open-ok")
    })
  })
})
