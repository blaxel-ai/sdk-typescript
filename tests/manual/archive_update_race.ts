/**
 * Manual reproducer: archive a sandbox and update it within a few hundred
 * milliseconds of each other.
 *
 * Both requests used to be accepted, and the sandbox ended up broken: ARCHIVED
 * with its VM still running, or DEPLOYED with a guest still frozen by the
 * export. With the shared sandbox lock exactly one request is accepted and the
 * other gets a 409.
 *
 * One sandbox per offset, all run in parallel. The offset is when the update
 * (a memory change, which redeploys the VM) is sent relative to the archive:
 * negative means before.
 *
 * Run:
 *   cd @blaxel/core && npm run build && cd ../..
 *   BL_ENV=dev BL_WORKSPACE=<workspace> npx tsx tests/manual/archive_update_race.ts
 *
 * Env:
 *   OFFSETS     ms, comma separated (default -300,-150,-50,0,50,150,250,350)
 *   MEMORY      memory at creation (default 2048)
 *   NEW_MEMORY  memory the update asks for (default 4096)
 *   IMAGE       default blaxel/base-image:latest
 *   REGION      optional
 *   SETTLE_MS   wait before reading where each sandbox ended up (default 90000)
 *   KEEP=1      keep the sandboxes
 */

import {
  SandboxInstance,
  archiveSandbox,
  getSandbox,
  settings,
  updateSandbox,
  type Sandbox,
} from "@blaxel/core"

const OFFSETS = (process.env.OFFSETS || "-300,-150,-50,0,50,150,250,350").split(",").map((o) => parseInt(o.trim(), 10))
const MEMORY = parseInt(process.env.MEMORY || "2048", 10)
const NEW_MEMORY = parseInt(process.env.NEW_MEMORY || "4096", 10)
const IMAGE = process.env.IMAGE || "blaxel/base-image:latest"
const REGION = process.env.REGION
const SETTLE_MS = parseInt(process.env.SETTLE_MS || "90000", 10)
const KEEP = process.env.KEEP === "1"
const LABELS = { env: "manual-test", "created-by": "archive-update-race" }
const run = Date.now().toString(36)

type Result = {
  offset: number
  name: string
  archive?: number
  update?: number
  status?: string
  probe?: string
  verdict?: string
  error?: string
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function at<T>(time: number, fn: () => Promise<T>): Promise<T> {
  return sleep(Math.max(0, time - Date.now())).then(fn)
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, sleep(ms).then(() => { throw new Error(`timed out after ${ms}ms`) })])
}

async function race(result: Result) {
  const sandbox = await SandboxInstance.create({ name: result.name, image: IMAGE, memory: MEMORY, region: REGION, labels: LABELS })
  await sandbox.wait()

  const { data: current } = await getSandbox({ path: { sandboxName: result.name }, throwOnError: true })
  const body = {
    ...current,
    spec: { ...current.spec, runtime: { ...current.spec?.runtime, memory: NEW_MEMORY } },
  } as Sandbox

  const archiveAt = Date.now() + 500 + Math.max(0, -result.offset)
  const [archived, updated] = await Promise.all([
    at(archiveAt, () => archiveSandbox({ path: { sandboxName: result.name } })),
    at(archiveAt + result.offset, () => updateSandbox({ path: { sandboxName: result.name }, body })),
  ])
  result.archive = archived.response?.status
  result.update = updated.response?.status
}

// Where the sandbox ended up, and whether its guest agrees with the record.
async function inspect(result: Result) {
  const { data } = await getSandbox({ path: { sandboxName: result.name }, throwOnError: true })
  result.status = data.status ?? "UNKNOWN"
  const ok = (code?: number) => code !== undefined && code >= 200 && code < 300
  const bothAccepted = ok(result.archive) && ok(result.update)
  const oneAccepted = ok(result.archive) !== ok(result.update)

  if (result.status === "DEPLOYED") {
    try {
      const sandbox = await SandboxInstance.get(result.name)
      const exec = await withTimeout(
        sandbox.process.exec({ command: "sh -c 'touch /root/.race-probe && echo ok'", waitForCompletion: true }),
        20_000,
      )
      result.probe = exec.exitCode === 0 ? "guest writable" : `exit ${exec.exitCode}`
    } catch (err) {
      result.probe = `guest not answering: ${(err as Error).message}`
    }
  } else if (result.status === "ARCHIVED") {
    // An archived sandbox has no instance: any answer that does not come from
    // the gateway itself (`X-Blaxel-Source: platform`) is the VM the archive
    // should have torn down, a frozen one answering 503 included.
    const url = data.metadata?.url ?? `${settings.runUrl}/${settings.workspace}/sandboxes/${result.name}`
    try {
      const res = await withTimeout(globalThis.fetch(`${url}/process`, { headers: settings.headers }), 20_000)
      result.probe = res.headers.get("x-blaxel-source") === "platform"
        ? `no guest (gateway ${res.status})`
        : `guest answered ${res.status}`
    } catch (err) {
      result.probe = `no guest (${(err as Error).message})`
    }
  }

  const broken =
    (result.status === "DEPLOYED" && result.probe !== "guest writable") ||
    (result.status === "ARCHIVED" && result.probe?.startsWith("guest answered") === true)
  if (bothAccepted) result.verdict = broken ? "RACE: both accepted, sandbox broken" : "RACE: both accepted"
  else if (broken) result.verdict = "BROKEN"
  else if (oneAccepted) result.verdict = "ok"
  else result.verdict = "neither accepted"
}

async function main() {
  console.log(`Workspace ${settings.workspace}, offsets ${OFFSETS.join(", ")} ms, ${MEMORY} -> ${NEW_MEMORY} MB`)
  const results: Result[] = OFFSETS.map((offset, i) => ({ offset, name: `arch-race-${run}-${i}` }))

  await Promise.all(results.map((r) => race(r).catch((err) => { r.error = (err as Error).message })))
  for (const r of results) console.log(`[${r.name}] update ${r.offset} ms: archive ${r.archive}, update ${r.update}`)

  console.log(`Waiting ${SETTLE_MS / 1000}s for archives and redeploys to settle...`)
  await sleep(SETTLE_MS)
  await Promise.all(results.filter((r) => !r.error).map((r) => inspect(r).catch((err) => { r.error = (err as Error).message })))

  console.table(results.map((r) => ({
    "update vs archive (ms)": r.offset,
    archive: r.archive,
    update: r.update,
    status: r.status,
    probe: r.probe,
    verdict: r.verdict ?? `error: ${r.error}`,
  })))

  if (!KEEP) {
    await Promise.all(results.map((r) => SandboxInstance.delete(r.name).catch(() => undefined)))
  }

  const failed = results.filter((r) => r.error || r.verdict !== "ok")
  console.log(failed.length === 0 ? "PASS: every pair had exactly one request accepted" : `FAIL: ${failed.length}/${results.length} not ok`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
