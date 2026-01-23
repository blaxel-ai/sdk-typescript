import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { SandboxInstance } from "@blaxel/core"
import { uniqueName, defaultImage, defaultLabels, sleep } from './helpers.js'

describe('Sandbox Session Operations', () => {
  let sandbox: SandboxInstance
  const sandboxName = uniqueName("session-test")

  beforeAll(async () => {
    sandbox = await SandboxInstance.create({
      name: sandboxName,
      image: defaultImage,
      memory: 2048,
      labels: defaultLabels,
    })
  })

  afterAll(async () => {
    try {
      await SandboxInstance.delete(sandboxName)
    } catch {
      // Ignore
    }
  })

  describe('create', () => {
    it('creates a session with expiration', async () => {
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000) // 1 day

      const session = await sandbox.sessions.create({ expiresAt })

      expect(session.name).toBeDefined()
      expect(session.token).toBeDefined()
      expect(session.url).toBeDefined()

      await sandbox.sessions.delete(session.name)
    })

    it('session has valid URL and token', async () => {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

      const session = await sandbox.sessions.create({ expiresAt })

      expect(session.url).toContain("http")
      expect(session.token.length).toBeGreaterThan(0)

      await sandbox.sessions.delete(session.name)
    })
  })

  describe('list', () => {
    it('lists all sessions', async () => {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000)

      const session1 = await sandbox.sessions.create({ expiresAt })
      const session2 = await sandbox.sessions.create({ expiresAt })

      const sessions = await sandbox.sessions.list()

      expect(sessions.length).toBeGreaterThanOrEqual(2)
      expect(sessions.find(s => s.name === session1.name)).toBeDefined()
      expect(sessions.find(s => s.name === session2.name)).toBeDefined()

      await sandbox.sessions.delete(session1.name)
      await sandbox.sessions.delete(session2.name)
    })
  })

  describe('delete', () => {
    it('deletes a session', async () => {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
      const session = await sandbox.sessions.create({ expiresAt })

      await sandbox.sessions.delete(session.name)

      const sessions = await sandbox.sessions.list()
      expect(sessions.find(s => s.name === session.name)).toBeUndefined()
    })
  })

  describe('fromSession', () => {
    it('creates sandbox instance from session', async () => {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
      const session = await sandbox.sessions.create({ expiresAt })

      const sandboxFromSession = await SandboxInstance.fromSession(session)

      // Should be able to perform operations
      const listing = await sandboxFromSession.fs.ls("/")
      expect(listing.subdirectories).toBeDefined()

      await sandbox.sessions.delete(session.name)
    })

    it('session sandbox can execute processes', async () => {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
      const session = await sandbox.sessions.create({ expiresAt })

      const sandboxFromSession = await SandboxInstance.fromSession(session)

      const result = await sandboxFromSession.process.exec({
        command: "echo 'from session'",
        waitForCompletion: true
      })

      expect(result.logs).toContain("from session")

      await sandbox.sessions.delete(session.name)
    })

    it('session sandbox can stream logs', async () => {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
      const session = await sandbox.sessions.create({ expiresAt })

      const sandboxFromSession = await SandboxInstance.fromSession(session)

      await sandboxFromSession.process.exec({
        name: "stream-session",
        command: "for i in 1 2 3; do echo $i; sleep 1; done",
        waitForCompletion: false
      })

      const logs: string[] = []
      const stream = sandboxFromSession.process.streamLogs("stream-session", {
        onLog: (log) => logs.push(log)
      })

      await sandboxFromSession.process.wait("stream-session")
      await sleep(100)
      stream.close()

      expect(logs.length).toBeGreaterThan(0)

      await sandbox.sessions.delete(session.name)
    })

    it('session sandbox can watch files', async () => {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
      const session = await sandbox.sessions.create({ expiresAt })

      const sandboxFromSession = await SandboxInstance.fromSession(session)

      const handle = sandboxFromSession.fs.watch("/", () => {
      })
      await sleep(100)
      await sandboxFromSession.fs.write("/session-test.txt", "content")

      await sleep(1000)
      handle.close()
      await sandbox.sessions.delete(session.name)
    })
  })
})
