/**
 * Integration tests that run against either the Blaxel cloud sandbox or a
 * local Docker-backed sandbox, controlled by a single env var:
 *
 *   SANDBOX_ENV=local   -> uses LocalSandboxInstance (Docker)
 *   SANDBOX_ENV=blaxel  -> uses SandboxInstance      (Blaxel cloud)  [default]
 *
 * The tests exercise the shared API surface so that the two implementations
 * can be validated with the exact same assertions.
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest"
import { SandboxInstance } from "@blaxel/core"
import { v4 as uuidv4 } from "uuid"
import { LocalSandboxInstance } from "./docker.js"

// ---------------------------------------------------------------------------
// Environment switch
// ---------------------------------------------------------------------------

const SANDBOX_ENV = (process.env.SANDBOX_ENV ?? "blaxel") as "local" | "blaxel"
const isLocal = SANDBOX_ENV === "local"

// In local mode the Docker image must be provided via LOCAL_SANDBOX_IMAGE.
// Falls back to the ghcr image available in most Blaxel dev setups.
const LOCAL_IMAGE =
  process.env.LOCAL_SANDBOX_IMAGE ?? "sandbox-local"

const BLAXEL_IMAGE = "blaxel/base-image:latest"
const BLAXEL_REGION = process.env.BL_ENV === "dev" ? "eu-dub-1" : "us-was-1"

function uniqueName(prefix: string): string {
  return `${prefix}-${uuidv4().replace(/-/g, "").substring(0, 8)}`
}

const defaultLabels = {
  env: "integration-test",
  language: "typescript",
  "created-by": "vitest-local-env",
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll until `getSandbox(name)` throws (sandbox fully gone) or we see a
 * terminal status. Returns true if the sandbox is confirmed gone.
 */
async function waitForGone(name: string, maxAttempts = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const sb = await getSandbox(name)
      if (sb.status === "TERMINATED") return true
    } catch {
      return true
    }
    await sleep(1000)
  }
  return false
}

// ---------------------------------------------------------------------------
// Factory -- abstracts away which implementation is used
// ---------------------------------------------------------------------------

type SandboxLike = SandboxInstance | LocalSandboxInstance

async function createSandbox(opts: {
  name: string
  labels?: Record<string, string>
  ports?: { target: number; protocol?: string; name?: string }[]
  envs?: { name: string; value: string }[]
}): Promise<SandboxLike> {
  if (isLocal) {
    return LocalSandboxInstance.create({
      name: opts.name,
      image: LOCAL_IMAGE,
      labels: opts.labels,
      ports: opts.ports as any,
      envs: opts.envs,
    })
  }
  return SandboxInstance.create({
    name: opts.name,
    image: BLAXEL_IMAGE,
    memory: 2048,
    region: BLAXEL_REGION,
    labels: opts.labels,
    ports: opts.ports as any,
    envs: opts.envs,
  })
}

async function getSandbox(name: string): Promise<SandboxLike> {
  if (isLocal) return LocalSandboxInstance.get(name)
  return SandboxInstance.get(name)
}

async function listSandboxes(): Promise<SandboxLike[]> {
  if (isLocal) return LocalSandboxInstance.list()
  return SandboxInstance.list()
}

async function deleteSandbox(name: string): Promise<void> {
  if (isLocal) return LocalSandboxInstance.delete(name)
  await SandboxInstance.delete(name)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe(`Sandbox local-environment (${SANDBOX_ENV})`, () => {
  // Track sandboxes for cleanup
  const createdSandboxes: string[] = []

  afterAll(async () => {
    await Promise.allSettled(
      createdSandboxes.map((name) => deleteSandbox(name).catch(() => {}))
    )
  })

  // -----------------------------------------------------------------------
  // CRUD
  // -----------------------------------------------------------------------

  describe("sandbox lifecycle", () => {
    it("creates a sandbox", async () => {
      const name = uniqueName("create")
      const sb = await createSandbox({ name, labels: defaultLabels })
      createdSandboxes.push(name)

      expect(sb.metadata.name).toBe(name)
    })

    it("gets a sandbox by name", async () => {
      const name = uniqueName("get")
      await createSandbox({ name, labels: defaultLabels })
      createdSandboxes.push(name)

      const retrieved = await getSandbox(name)
      expect(retrieved.metadata.name).toBe(name)
    })

    it("lists sandboxes", async () => {
      const name = uniqueName("list")
      await createSandbox({ name, labels: defaultLabels })
      createdSandboxes.push(name)

      const all = await listSandboxes()
      const found = all.find((s) => s.metadata.name === name)
      expect(found).toBeDefined()
    })

    it("deletes a sandbox", async () => {
      const name = uniqueName("delete")
      await createSandbox({ name, labels: defaultLabels })

      await deleteSandbox(name)

      // In blaxel mode deletion is eventual -- poll until the sandbox is gone
      // or its status is DELETING/TERMINATED.
      if (isLocal) {
        await expect(getSandbox(name)).rejects.toThrow()
      } else {
        const gone = await waitForGone(name)
        expect(gone).toBe(true)
      }
    })

    it("delete via instance method", async () => {
      const name = uniqueName("del-inst")
      const sb = await createSandbox({ name, labels: defaultLabels })

      await sb.delete()

      if (isLocal) {
        await expect(getSandbox(name)).rejects.toThrow()
      } else {
        const gone = await waitForGone(name)
        expect(gone).toBe(true)
      }
    })
  })

  // -----------------------------------------------------------------------
  // Process + Filesystem (runtime operations hitting the container API)
  // -----------------------------------------------------------------------

  describe("runtime operations", () => {
    let sandbox: SandboxLike
    const sandboxName = uniqueName("runtime")

    beforeAll(async () => {
      sandbox = await createSandbox({ name: sandboxName, labels: defaultLabels })
      createdSandboxes.push(sandboxName)
    })

    afterAll(async () => {
      await deleteSandbox(sandboxName).catch(() => {})
    })

    it("executes a simple command", async () => {
      const result = await sandbox.process.exec({
        command: "echo 'Hello World'",
        waitForCompletion: true,
      })

      expect(result.status).toBe("completed")
      expect(result.logs).toContain("Hello World")
    })

    it("captures exit code", async () => {
      const ok = await sandbox.process.exec({
        command: "exit 0",
        waitForCompletion: true,
      })
      expect(ok.exitCode).toBe(0)

      const fail = await sandbox.process.exec({
        command: "exit 42",
        waitForCompletion: true,
      })
      expect(fail.exitCode).toBe(42)
    })

    it("writes and reads a file", async () => {
      const content = "hello from test"
      await sandbox.fs.write("/tmp/test-file.txt", content)
      const result = await sandbox.fs.read("/tmp/test-file.txt")
      expect(result).toBe(content)
    })

    it("lists a directory", async () => {
      await sandbox.fs.write("/tmp/ls-test/file.txt", "x")
      const listing = await sandbox.fs.ls("/tmp/ls-test")
      expect(listing.files?.some((f: any) => f.name === "file.txt")).toBe(true)
    })

    it("removes a file", async () => {
      await sandbox.fs.write("/tmp/rm-test.txt", "gone")
      await sandbox.fs.rm("/tmp/rm-test.txt")
      await expect(sandbox.fs.read("/tmp/rm-test.txt")).rejects.toThrow()
    })
  })

  // -----------------------------------------------------------------------
  // Previews (in-memory shim for local, control plane for blaxel)
  // -----------------------------------------------------------------------

  describe("previews", () => {
    let sandbox: SandboxLike
    const sandboxName = uniqueName("preview")

    beforeAll(async () => {
      sandbox = await createSandbox({ name: sandboxName, labels: defaultLabels })
      createdSandboxes.push(sandboxName)
    })

    afterAll(async () => {
      await deleteSandbox(sandboxName).catch(() => {})
    })

    it("creates a preview", async () => {
      const preview = await sandbox.previews.create({
        metadata: { name: "test-preview" },
        spec: { port: 3000, public: true },
      } as any)

      expect(preview.metadata.name).toBe("test-preview")
      expect(preview.spec.url).toBeDefined()

      await sandbox.previews.delete("test-preview")
    })

    it("lists previews", async () => {
      await sandbox.previews.create({
        metadata: { name: "list-a" },
        spec: { port: 3000, public: true },
      } as any)
      await sandbox.previews.create({
        metadata: { name: "list-b" },
        spec: { port: 3000, public: true },
      } as any)

      const previews = await sandbox.previews.list()
      const names = previews.map((p: any) => p.metadata?.name ?? p.name)
      expect(names).toContain("list-a")
      expect(names).toContain("list-b")

      await sandbox.previews.delete("list-a")
      await sandbox.previews.delete("list-b")
    })

    it("deletes a preview", async () => {
      await sandbox.previews.create({
        metadata: { name: "del-preview" },
        spec: { port: 3000, public: true },
      } as any)

      await sandbox.previews.delete("del-preview")

      const previews = await sandbox.previews.list()
      const names = previews.map((p: any) => p.metadata?.name ?? p.name)
      expect(names).not.toContain("del-preview")
    })

    it("get returns the right preview", async () => {
      await sandbox.previews.create({
        metadata: { name: "get-preview" },
        spec: { port: 3000, public: true },
      } as any)

      const preview = await sandbox.previews.get("get-preview")
      const previewName = (preview as any).metadata?.name ?? (preview as any).name
      expect(previewName).toBe("get-preview")

      await sandbox.previews.delete("get-preview")
    })
  })

  // -----------------------------------------------------------------------
  // Sessions
  // -----------------------------------------------------------------------

  describe("sessions", () => {
    let sandbox: SandboxLike
    const sandboxName = uniqueName("session")

    beforeAll(async () => {
      sandbox = await createSandbox({ name: sandboxName, labels: defaultLabels })
      createdSandboxes.push(sandboxName)
    })

    afterAll(async () => {
      await deleteSandbox(sandboxName).catch(() => {})
    })

    it("creates a session with url and token", async () => {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
      const session = await sandbox.sessions.create({ expiresAt })

      expect(session.name).toBeDefined()
      expect(session.url).toContain("http")
      expect(session.token.length).toBeGreaterThan(0)

      await sandbox.sessions.delete(session.name)
    })

    it("lists sessions", async () => {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
      const s1 = await sandbox.sessions.create({ expiresAt })
      const s2 = await sandbox.sessions.create({ expiresAt })

      const sessions = await sandbox.sessions.list()
      expect(sessions.length).toBeGreaterThanOrEqual(2)
      expect(sessions.find((s) => s.name === s1.name)).toBeDefined()
      expect(sessions.find((s) => s.name === s2.name)).toBeDefined()

      await sandbox.sessions.delete(s1.name)
      await sandbox.sessions.delete(s2.name)
    })

    it("deletes a session", async () => {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
      const session = await sandbox.sessions.create({ expiresAt })

      await sandbox.sessions.delete(session.name)

      const sessions = await sandbox.sessions.list()
      expect(sessions.find((s) => s.name === session.name)).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // Drives (no-op shim for local, real for blaxel)
  // -----------------------------------------------------------------------

  describe("drives", () => {
    // Drive operations only make sense to test in local mode since the blaxel
    // mode requires actual drive resources to exist in the workspace. For
    // blaxel, we skip these tests entirely.
    const skipDrives = !isLocal

    let sandbox: SandboxLike
    const sandboxName = uniqueName("drive")

    beforeAll(async () => {
      if (skipDrives) return
      sandbox = await createSandbox({ name: sandboxName, labels: defaultLabels })
      createdSandboxes.push(sandboxName)
    })

    afterAll(async () => {
      if (skipDrives) return
      await deleteSandbox(sandboxName).catch(() => {})
    })

    it("mount returns success", async () => {
      if (skipDrives) return
      const result = await sandbox.drives.mount({
        driveName: "test-drive",
        mountPath: "/mnt/data",
      })
      expect(result.success).toBe(true)
    })

    it("list returns mounted drives", async () => {
      if (skipDrives) return
      await sandbox.drives.mount({ driveName: "list-drive", mountPath: "/mnt/list" })
      const mounts = await sandbox.drives.list()
      expect(mounts.find((m) => m.driveName === "list-drive")).toBeDefined()
    })

    it("unmount removes the mount", async () => {
      if (skipDrives) return
      await sandbox.drives.mount({ driveName: "rm-drive", mountPath: "/mnt/rm" })
      await sandbox.drives.unmount("/mnt/rm")
      const mounts = await sandbox.drives.list()
      expect(mounts.find((m) => m.mountPath === "/mnt/rm")).toBeUndefined()
    })
  })
})
