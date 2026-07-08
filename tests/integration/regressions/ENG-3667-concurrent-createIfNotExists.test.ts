// ENG-3667: real-API reproducer for transient createIfNotExists failures.
//
// Production symptom (~237 failures/day): N concurrent createIfNotExists()
// calls for the SAME name race; one wins the creation lock, the others get a
// 409 on create then a 404 on the status get (row not persisted yet). The SDK
// labels this "vanished" and gives up after 3 attempts / ~1s of waiting,
// throwing "Unable to create sandbox after 3 attempts. Last conflicting
// status: vanished." even though the sandbox appears moments later.
//
// These tests assert the CORRECT behaviour (every racer converges on the one
// sandbox; data-plane calls right after create never surface a raw
// WORKLOAD_UNAVAILABLE 404). While the bug exists they fail whenever the race
// window is hit, which is the reproduction; after a fix they become the
// regression tests.
import { SandboxInstance } from "@blaxel/core"
import { afterAll, describe, expect, it } from "vitest"
import { defaultImage, defaultLabels, defaultRegion, uniqueName } from "../sandbox/helpers.js"

// Defaults keep the test under the 1-minute budget; crank via env to stress.
const ROUNDS = parseInt(process.env.ENG3667_ROUNDS || "5", 10)
const CONCURRENCY = parseInt(process.env.ENG3667_CONCURRENCY || "10", 10)

const errMessage = (reason: unknown) =>
  reason instanceof Error ? reason.message : JSON.stringify(reason)

describe("ENG-3667: transient createIfNotExists failures (real API)", () => {
  const created: string[] = []

  afterAll(async () => {
    await Promise.all(
      created.map(async (name) => {
        try {
          await SandboxInstance.delete(name)
        } catch {
          // best-effort cleanup
        }
      })
    )
  })

  it("concurrent createIfNotExists on one name all converge (no 'vanished')", async () => {
    const failures: string[] = []

    for (let round = 0; round < ROUNDS; round++) {
      const name = uniqueName("eng3667")
      created.push(name)

      const results = await Promise.allSettled(
        Array.from({ length: CONCURRENCY }, () =>
          SandboxInstance.createIfNotExists({
            name,
            image: defaultImage,
            memory: 2048,
            labels: defaultLabels,
            region: defaultRegion,
          })
        )
      )

      results.forEach((r, i) => {
        if (r.status === "rejected") {
          failures.push(`round ${round + 1} call#${i}: ${errMessage(r.reason)}`)
        } else {
          expect(r.value.metadata.name).toBe(name)
        }
      })
    }

    // Any rejection here (typically "... Last conflicting status: vanished.")
    // is the production transient failure this test reproduces.
    expect(failures, failures.join("\n")).toEqual([])
  }, 120_000)

  it("createIfNotExists racing an in-flight delete of the same name succeeds", async () => {
    // The 'vanished' comment in sandbox.ts:404 names this exact window: create
    // conflicts (409) with a record whose deletion then finishes before the
    // status get (404). Deleting and immediately recreating the same name is
    // the most direct way to sit in that window.
    const failures: string[] = []

    for (let round = 0; round < ROUNDS; round++) {
      const name = uniqueName("eng3667-del")
      created.push(name)
      await SandboxInstance.create({
        name,
        image: defaultImage,
        memory: 2048,
        labels: defaultLabels,
        region: defaultRegion,
      })

      // Fire the delete and the recreates together: some racers hit the 409
      // (delete in flight) then the 404 (record gone) -- the vanished path.
      const [, ...recreates] = await Promise.allSettled([
        SandboxInstance.delete(name),
        ...Array.from({ length: CONCURRENCY }, () =>
          SandboxInstance.createIfNotExists({
            name,
            image: defaultImage,
            memory: 2048,
            labels: defaultLabels,
            region: defaultRegion,
          })
        ),
      ])

      recreates.forEach((r, i) => {
        if (r.status === "rejected") {
          failures.push(`round ${round + 1} call#${i}: ${errMessage(r.reason)}`)
        }
      })
    }

    expect(failures, failures.join("\n")).toEqual([])
  }, 180_000)

  it("process calls immediately after create never surface WORKLOAD_UNAVAILABLE", async () => {
    const name = uniqueName("eng3667-wu")
    created.push(name)
    const sandbox = await SandboxInstance.create({
      name,
      image: defaultImage,
      memory: 2048,
      labels: defaultLabels,
      region: defaultRegion,
    })

    // Hammer the data plane right after create returns: the gateway can still
    // answer 404 WORKLOAD_UNAVAILABLE (record exists, no healthy pod yet), and
    // the SDK never retries it because isTransientResetError short-circuits on
    // any HTTP status.
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        sandbox.process.exec({ command: `echo ${i}` })
      )
    )

    const failures = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => errMessage(r.reason))
    expect(failures, failures.join("\n")).toEqual([])
  }, 60_000)
})
