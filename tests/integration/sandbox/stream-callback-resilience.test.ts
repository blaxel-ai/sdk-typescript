import { SandboxInstance } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName } from './helpers.js'

/**
 * A log stream must outlive its consumer's mistakes.
 *
 * A caller whose onLog parses every line hits an exception the moment a line is
 * not what it expects. That exception used to escape the SDK read loop and end
 * the stream for good, while the sandbox process kept running and producing
 * output nobody received: the process looks healthy, the client sees silence.
 */
describe('Log stream survives a throwing callback', () => {
  const createdSandboxes: string[] = []

  afterAll(async () => {
    await Promise.all(
      createdSandboxes.map(async (name) => {
        try {
          await SandboxInstance.delete(name)
        } catch {
          // Ignore cleanup errors
        }
      })
    )
  })

  it('keeps delivering lines after onLog throws, and the process lives on', async () => {
    const name = uniqueName("stream-cb")

    const sandbox = await SandboxInstance.create({
      name,
      image: defaultImage,
      memory: 4096,
      region: defaultRegion,
      labels: defaultLabels,
    })
    createdSandboxes.push(name)
    await sandbox.wait({ maxWait: 120000, interval: 1000 })

    // Emits JSON lines with one unparseable line in the middle, then keeps going.
    await sandbox.process.exec({
      name: "emitter",
      command: `sh -c 'i=0; while [ $i -lt 8 ]; do if [ $i -eq 2 ]; then echo "not-json-at-all"; else echo "{\\"tick\\":$i}"; fi; i=$((i+1)); sleep 1; done; echo DONE; sleep 30'`,
      waitForCompletion: false,
    })

    const parsed: number[] = []
    const errors: string[] = []
    const control = sandbox.process.streamLogs("emitter", {
      onLog: (line) => {
        const trimmed = line.trim()
        if (!trimmed || trimmed === "DONE") return
        parsed.push((JSON.parse(trimmed) as { tick: number }).tick)
      },
      onError: (e) => errors.push(e.message),
    })

    // Long enough for every tick, short enough to keep the test under a minute.
    await new Promise((resolve) => setTimeout(resolve, 15000))
    control.close()
    await control.wait()

    // The bad line is reported, not fatal: ticks after it still arrive.
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(errors[0]).toMatch(/JSON/i)
    expect(parsed).toContain(7)
    expect(parsed).toEqual([0, 1, 3, 4, 5, 6, 7])

    // And the process was never the problem.
    const info = await sandbox.process.get("emitter")
    expect(info.status).toBe("running")
  })
})
