import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { SandboxInstance } from "@blaxel/core"
import { uniqueName, defaultImage, defaultLabels, defaultRegion, sleep } from './helpers.js'

// Mirrors the controlplane `e2e-sandbox-scheduling` skill, scoped to the SDK
// wrapper (`sandbox.schedules`): exercises the CRUD surface and proves real
// firing through the scheduler. No stress mode -- just "does it work".
//
// Requires a real environment (BL_WORKSPACE + BL_API_KEY): the local stack does
// not run the scheduler, so the firing assertions only pass against dev/prod.

const RUN = uniqueName("run").replace("run-", "")
const CRON_MARK = `SCHEDMARK-CRON-${RUN}`
const AT_MARK = `SCHEDMARK-AT-${RUN}`
const SLEEP_MARK = `SCHEDMARK-SLEEP-${RUN}`

// A one-off `at` schedule auto-deletes its definition shortly after it fires, so
// its disappearance from list() is a firing proof that is robust to the sandbox
// scaling to zero AND version-independent (the execution-history endpoint is
// only populated from Blaxel-Version 2026-04-28 on). Allow for fire latency plus
// the backend cleanup pass (~45s observed) with margin.
const FIRE_TIMEOUT_MS = 75_000

// Poll until the given schedule is gone from list() (i.e. it fired and the
// one-off was auto-removed). Returns true if it disappeared before the deadline.
async function waitUntilGone(sandbox: SandboxInstance, scheduleId: string): Promise<boolean> {
  const deadline = Date.now() + FIRE_TIMEOUT_MS
  while (Date.now() < deadline) {
    const list = await sandbox.schedules.list().catch(() => [])
    if (!list.find((s) => s.id === scheduleId)) return true
    await sleep(3000)
  }
  return false
}

describe('Sandbox Schedule Operations', () => {
  let sandbox: SandboxInstance
  const sandboxName = uniqueName("schedule-test")

  beforeAll(async () => {
    sandbox = await SandboxInstance.create({
      name: sandboxName,
      image: defaultImage,
      region: defaultRegion,
      memory: 2048,
      labels: defaultLabels,
    })
  }, 120_000)

  afterAll(async () => {
    try {
      // Deleting the sandbox cascades to its schedules + execution history.
      await SandboxInstance.delete(sandboxName)
    } catch {
      // Ignore
    }
  })

  describe('CRUD', () => {
    const createdIds: string[] = []

    afterAll(async () => {
      for (const id of createdIds) {
        await sandbox.schedules.delete(id).catch(() => {})
      }
    })

    it('creates the three schedule timing types', async () => {
      const cron = await sandbox.schedules.create({
        type: "cron",
        value: "0 8 * * 1-5",
        input: { command: `echo ${CRON_MARK}`, keepAlive: true, timeout: 60 },
      })
      expect(cron.id).toBeDefined()
      expect(cron.type).toBe("cron")
      createdIds.push(cron.id!)

      const at = await sandbox.schedules.create({
        type: "at",
        value: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        input: { command: `echo ${AT_MARK}`, keepAlive: true, timeout: 60 },
      })
      expect(at.type).toBe("at")
      createdIds.push(at.id!)
    })

    it('resolves a sleep schedule to an absolute at', async () => {
      const sleepSched = await sandbox.schedules.create({
        type: "sleep",
        value: "1h",
        input: { command: `echo ${SLEEP_MARK}`, keepAlive: true, timeout: 60 },
      })
      // The backend resolves "sleep" to a concrete "at" with an RFC 3339 value.
      expect(sleepSched.type).toBe("at")
      expect(() => new Date(sleepSched.value!).toISOString()).not.toThrow()
      createdIds.push(sleepSched.id!)
    })

    it('lists the created schedules', async () => {
      const schedules = await sandbox.schedules.list()
      expect(schedules.length).toBeGreaterThanOrEqual(createdIds.length)
      for (const id of createdIds) {
        expect(schedules.find((s) => s.id === id)).toBeDefined()
      }
    })

    it('passes the type filter through to list', async () => {
      // The wrapper forwards `type` as a query param; the server only enforces
      // it from Blaxel-Version 2026-04-28 on, so just assert the call works and
      // still surfaces the cron we created (subset, not exact match).
      const crons = await sandbox.schedules.list({ type: "cron" })
      expect(Array.isArray(crons)).toBe(true)
      expect(crons.find((s) => s.id === createdIds[0])).toBeDefined()
    })

    it('gets a single schedule by id', async () => {
      const got = await sandbox.schedules.get(createdIds[0])
      expect(got.id).toBe(createdIds[0])
      expect(got.input?.command).toContain(CRON_MARK)
    })

    it('updates a schedule', async () => {
      const id = createdIds[0]
      const updated = await sandbox.schedules.update(id, {
        type: "cron",
        value: "0 9 * * 1-5",
        input: { command: `echo ${CRON_MARK}-updated`, keepAlive: true, timeout: 60 },
      })
      expect(updated.value).toBe("0 9 * * 1-5")

      const got = await sandbox.schedules.get(id)
      expect(got.input?.command).toContain("updated")
    })

    it('deletes a schedule', async () => {
      const id = createdIds.pop()!
      await sandbox.schedules.delete(id)
      const schedules = await sandbox.schedules.list()
      expect(schedules.find((s) => s.id === id)).toBeUndefined()
    })
  })

  // Firing depends on the scheduler tick + a backend cleanup pass whose latency
  // can push this block past the 1-minute integration-test budget, so it is
  // opt-in. Enable with RUN_SLOW_SCHEDULES=1; the default run stays CRUD-only.
  describe.runIf(process.env.RUN_SLOW_SCHEDULES)('firing', () => {
    it('fires a one-off at schedule (auto-deletes after firing)', async () => {
      // Fire ~10s out; the scheduler runs it and then auto-removes the one-off
      // definition, which is our version-independent proof that it fired.
      const at = await sandbox.schedules.create({
        type: "at",
        value: new Date(Date.now() + 10_000).toISOString(),
        input: { command: `echo ${AT_MARK}-fire`, keepAlive: true, timeout: 60 },
      })
      expect(at.id).toBeDefined()

      // Visible in list() right after creation, gone once it has fired.
      const before = await sandbox.schedules.list()
      expect(before.find((s) => s.id === at.id)).toBeDefined()

      const fired = await waitUntilGone(sandbox, at.id!)
      expect(fired).toBe(true)

      // The execution-history endpoint is exercised here too. It is only
      // populated from Blaxel-Version 2026-04-28 on, so just assert the wrapper
      // call works and returns an array (no firing-count assertion).
      const executions = await sandbox.schedules.executions()
      expect(Array.isArray(executions)).toBe(true)
    }, FIRE_TIMEOUT_MS + 30_000)
  })
})
