import { SandboxInstance, VolumeInstance } from "@blaxel/core"
import { afterAll, describe, expect, it } from "vitest"
import { defaultImage, defaultLabels, defaultRegion, sleep, uniqueName, waitForSandboxDeletion } from "./helpers.js"

const BOOT_ID = "cat /proc/sys/kernel/random/boot_id"

async function run(sandbox: SandboxInstance, command: string): Promise<string> {
  const result = await sandbox.process.exec({ command, waitForCompletion: true })
  return (result.logs ?? "").trim()
}

async function exists(sandbox: SandboxInstance, path: string): Promise<boolean> {
  try {
    await sandbox.fs.read(path)
    return true
  } catch {
    return false
  }
}

describe("Sandbox reset", () => {
  const sandboxes: string[] = []
  const volumes: string[] = []

  afterAll(async () => {
    await Promise.all(
      sandboxes.map(async (name) => {
        try {
          await SandboxInstance.delete(name)
          await waitForSandboxDeletion(name)
        } catch {
          // Ignore cleanup errors
        }
      })
    )
    await Promise.all(
      volumes.map(async (name) => {
        try {
          await VolumeInstance.delete(name)
        } catch {
          // Ignore cleanup errors
        }
      })
    )
  })

  it("gives back a fresh copy of the image and keeps the rest of the sandbox", async () => {
    const name = uniqueName("reset")
    const sandbox = await SandboxInstance.create({
      name,
      image: defaultImage,
      memory: 2048,
      region: defaultRegion,
      envs: [{ name: "RESET_SECRET", value: "kept-across-reset" }],
      ports: [{ name: "web", target: 3000, protocol: "HTTP" }],
      labels: { ...defaultLabels, team: "reset-test" },
    })
    sandboxes.push(name)

    // Everything a user could have done to the sandbox since it started.
    await sandbox.fs.write("/home/user/leftover.txt", "build artifact")
    await run(sandbox, "mkdir -p /tmp/leftover && echo x > /tmp/leftover/x")
    await sandbox.process.exec({ name: "leftover-proc", command: "sleep 3600" })
    const preview = await sandbox.previews.create({
      metadata: { name: "reset-preview" },
      spec: { port: 3000, public: false },
    })
    const token = await preview.tokens.create(new Date(Date.now() + 3_600_000))
    const bootBefore = await run(sandbox, BOOT_ID)
    const before = await SandboxInstance.get(name)

    const started = Date.now()
    const result = await sandbox.reset()
    const elapsed = Date.now() - started

    // Back to DEPLOYED, on the instance that was called, in seconds.
    expect(result).toBe(sandbox)
    expect(sandbox.status).toBe("DEPLOYED")
    expect(sandbox.spec.enabled).not.toBe(false)
    expect(elapsed).toBeLessThan(45_000)

    // A new instance from the image: another boot, nothing left behind.
    expect(await run(sandbox, BOOT_ID)).not.toBe(bootBefore)
    expect(await exists(sandbox, "/home/user/leftover.txt")).toBe(false)
    expect(await exists(sandbox, "/tmp/leftover/x")).toBe(false)
    expect(await run(sandbox, "ps aux | grep -c '[s]leep 3600' || true")).toBe("0")

    // The same sandbox: record, spec, secret environment variable, previews.
    const after = await SandboxInstance.get(name)
    expect(after.metadata.createdAt).toBe(before.metadata.createdAt)
    expect(after.metadata.labels).toMatchObject({ team: "reset-test" })
    expect(after.spec.runtime?.image).toBe(defaultImage)
    expect(after.spec.runtime?.memory).toBe(2048)
    expect(after.spec.runtime?.ports?.map((p) => p.target)).toContain(3000)
    expect(await run(after, 'printf "%s" "$RESET_SECRET"')).toBe("kept-across-reset")
    const previews = await after.previews.list()
    expect(previews.map((p) => p.name)).toContain("reset-preview")
    const tokens = await previews.find((p) => p.name === "reset-preview")!.tokens.list()
    expect(tokens.map((t) => t.value)).toContain(token.value)

    // It keeps working afterwards, and resetting again works too.
    await after.fs.write("/home/user/after.txt", "ok")
    const again = await SandboxInstance.reset(name)
    expect(again.status).toBe("DEPLOYED")
    expect(await exists(again, "/home/user/after.txt")).toBe(false)
  })

  it("keeps an attached volume and its data", async () => {
    const volumeName = uniqueName("reset-vol")
    const name = uniqueName("reset-volume")
    await VolumeInstance.create({ name: volumeName, size: 1024, region: defaultRegion, labels: defaultLabels })
    volumes.push(volumeName)
    const sandbox = await SandboxInstance.create({
      name,
      image: defaultImage,
      region: defaultRegion,
      volumes: [{ name: volumeName, mountPath: "/data", readOnly: false }],
      labels: defaultLabels,
    })
    sandboxes.push(name)
    await run(sandbox, "echo persistent > /data/keep.txt")
    await sandbox.fs.write("/home/user/leftover.txt", "build artifact")

    await sandbox.reset()

    expect(await exists(sandbox, "/home/user/leftover.txt")).toBe(false)
    expect(await run(sandbox, "cat /data/keep.txt")).toBe("persistent")
    expect(sandbox.spec.volumes?.map((v) => v.name)).toEqual([volumeName])
    // The volume is mounted for writing again.
    await run(sandbox, "echo second > /data/second.txt")
    expect(await run(sandbox, "cat /data/second.txt")).toBe("second")
  })

  it("does not bring a deleted sandbox back to life", async () => {
    const name = uniqueName("reset-deleted")
    await SandboxInstance.create({ name, image: defaultImage, region: defaultRegion, labels: defaultLabels })
    sandboxes.push(name)
    await SandboxInstance.delete(name)
    await waitForSandboxDeletion(name)

    await expect(SandboxInstance.reset(name)).rejects.toSatisfy((e: unknown) => {
      // Either the record is gone (404) or it is still there as TERMINATED/DELETING.
      const err = e as { code?: number; message?: string }
      return err.code === 404 || /cannot be reset/.test(err.message ?? "")
    })

    // Still not running after the refused call.
    await sleep(2000)
    const status = await SandboxInstance.get(name).then((s) => s.status, () => "GONE")
    expect(["TERMINATED", "DELETING", "GONE"]).toContain(status)
  })
})
