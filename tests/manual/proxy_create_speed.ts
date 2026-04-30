import { SandboxInstance } from "@blaxel/core"
import { v4 as uuidv4 } from "uuid"

const IMAGE = "blaxel/base-image:latest"
const LABELS = { env: "manual-test", "created-by": "proxy-create-speed-test" }
const EXEC_TIMEOUT_MS = 30_000

function uniqueName(prefix: string): string {
  return `${prefix}-${uuidv4().replace(/-/g, "").substring(0, 8)}`
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

async function timeCreate(label: string, withProxy: boolean): Promise<void> {
  const name = uniqueName(withProxy ? "with-proxy" : "no-proxy")
  console.log(`[${label}] creating ${name}...`)

  const start = Date.now()
  let sbx: SandboxInstance | null = null
  try {
    sbx = await SandboxInstance.create({
      name,
      image: IMAGE,
      labels: LABELS,
      memory: 2048,
      ...(withProxy
        ? {
            network: {
              proxy: {
                routing: [
                  { destinations: ["httpbin.org"], headers: { "X-Manual-Test": "proxy-speed-bench" } },
                ],
              },
            },
          }
        : {}),
    })
    const createMs = Date.now() - start
    console.log(`[${label}] created in ${createMs}ms`)

    const execStart = Date.now()
    try {
      await withTimeout(
        sbx.process.exec({ command: "echo hello", waitForCompletion: true }),
        EXEC_TIMEOUT_MS,
        "first exec"
      )
      const execMs = Date.now() - execStart
      console.log(`[${label}] first exec in ${execMs}ms (total ${createMs + execMs}ms)`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[${label}] first exec failed: ${msg}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[${label}] create failed: ${msg}`)
  } finally {
    try {
      if (sbx) await sbx.delete()
      else await SandboxInstance.delete(name)
    } catch {}
  }
}

async function main() {
  await Promise.all([
    timeCreate("no-proxy  ", false),
    timeCreate("with-proxy", true),
  ])
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
