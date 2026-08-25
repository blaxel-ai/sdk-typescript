/**
 * Build a deliberately huge (500MB - 1GB) Node.js app inside a sandbox and
 * serve it through a public preview.
 *
 * Why: the archive system (a standby sandbox whose filesystem is archived to
 * object storage and restored on the next request) only gets interesting once
 * the filesystem is big. Hand-made 10MB test sandboxes archive and restore in
 * no time, so they prove nothing. This script produces, in one command, a
 * sandbox with a real app whose weight comes from real npm dependencies, and a
 * preview URL that answers a machine-checkable integrity endpoint — so after an
 * archive/restore cycle you can tell whether the files came back intact, and
 * how long the restore took.
 *
 * The app is a Next.js (app router) project. Its size comes from installing
 * heavy, widely-used open source packages stage by stage, measuring the app
 * directory after each stage, and stopping as soon as the target size is
 * reached — so the run is as short as the target allows. With every stage
 * installed the app weighs about 1.5GB.
 *
 * The app exposes:
 *   GET /             human-readable page with the app's size and integrity
 *   GET /api/verify   { ok, sizeMb, fileCount, samples: [{path, ok, ...}] }
 *
 * `samples` are files picked across the app and sha256'd at build time;
 * the endpoint re-hashes them on every request. A restore that loses or
 * corrupts files shows up as `ok: false` rather than as a page that merely
 * looks fine.
 *
 * The sandbox is KEPT at the end (with a TTL) — archiving it is the point.
 * Pass --delete for a self-contained smoke run.
 *
 * Auth: whatever `bl login` left in ~/.blaxel, or BL_WORKSPACE + BL_API_KEY.
 *
 * Run:
 *   cd @blaxel/core && npm run build && cd ../..
 *   npx tsx tests/manual/large_app_preview.ts
 *   npx tsx tests/manual/large_app_preview.ts --target-mb 1024 --name my-big-app
 *   npx tsx tests/manual/large_app_preview.ts --reuse my-big-app --idle-min 20
 *   npx tsx tests/manual/large_app_preview.ts --count 5 --name fleet
 *   npx tsx tests/manual/large_app_preview.ts --delete-all fleet
 *
 * Options:
 *   --target-mb <n>   app size on disk to reach, in MB (default 700)
 *   --name <name>     sandbox name (default large-app-<random>)
 *   --reuse <name>    skip creation/install, just probe an existing sandbox
 *   --idle-min <n>    after serving, stay silent for n minutes so the sandbox
 *                     goes to standby and gets archived, then probe again and
 *                     report the restore latency and the integrity check
 *   --keep-alive      keep a process running so the sandbox never goes to
 *                     standby (useful to hold a demo sandbox up)
 *   --delete          delete the sandbox at the end (with --reuse, delete it and
 *                     do nothing else)
 *   --ttl <duration>  sandbox TTL (default 24h)
 *   --memory <mb>     sandbox memory (default 4096)
 *   --image <image>   sandbox image (default blaxel/base-image:latest)
 *   --count <n>       build n sandboxes at once, named <name>-1..<name>-n
 *                     (default 1). Combine with --idle-min to archive a whole
 *                     fleet, or with --delete for a batch smoke run
 *   --concurrency <n> how many of them to build in parallel (default 4)
 *   --delete-all <p>  delete every sandbox this script created whose name
 *                     starts with <p>, and do nothing else
 */

import { SandboxInstance } from "@blaxel/core"

const APP_PORT = 3000
const APP_DIR = "/app/large-app"
const PREVIEW_NAME = "large-app"
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000
const BUILD_TIMEOUT_MS = 20 * 60 * 1000
const PROBE_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Heavy, well-known open source packages, in stages. Installed in order until
 * the target size is reached, biggest bang per install first. Versions are
 * pinned so a run's size is reproducible.
 */
const STAGES: { label: string; packages: string[]; env?: Record<string, string> }[] = [
  // The app itself: Next.js pulls in the platform-specific SWC binaries.
  { label: "next", packages: ["next@16.3.3", "react@19.2.8", "react-dom@19.2.8"] },
  // Toolchains, each shipping its own native binaries.
  { label: "toolchains", packages: ["typescript@5.9.3", "vite@8.2.2", "esbuild@0.28.2", "@swc/core@1.16.1", "webpack@5.109.2"] },
  // Fat SDKs and media/graphics libraries.
  { label: "sdks", packages: ["@aws-sdk/client-s3@3.1117.0", "sharp@0.35.3", "three@0.185.1", "rxjs@7.8.2"] },
  { label: "linters", packages: ["eslint@10.9.1", "prettier@3.9.6", "jest@30.4.2"] },
  { label: "angular", packages: ["@angular/cli@22.1.5", "playwright-core@1.62.1"] },
  // The heaviest stage: puppeteer downloads a full Chrome on install. Its
  // cache is redirected into the app, otherwise the browser lands in ~/.cache
  // and is not part of what is being sized.
  { label: "chrome", packages: ["puppeteer@25.9.0"], env: { PUPPETEER_CACHE_DIR: `${APP_DIR}/.cache/puppeteer` } },
]

type Options = {
  targetMb: number
  name: string
  reuse?: string
  idleMin: number
  keepAlive: boolean
  del: boolean
  ttl: string
  memory: number
  image: string
  count: number
  concurrency: number
  deleteAll?: string
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    targetMb: 700,
    name: `large-app-${Math.random().toString(36).slice(2, 8)}`,
    idleMin: 0,
    keepAlive: false,
    del: false,
    ttl: "24h",
    memory: 4096,
    image: "blaxel/base-image:latest",
    count: 1,
    concurrency: 4,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${arg} needs a value`)
      return v
    }
    switch (arg) {
      case "--target-mb":
        options.targetMb = Number(value())
        break
      case "--name":
        options.name = value()
        break
      case "--reuse":
        options.reuse = value()
        break
      case "--idle-min":
        options.idleMin = Number(value())
        break
      case "--keep-alive":
        options.keepAlive = true
        break
      case "--delete":
        options.del = true
        break
      case "--ttl":
        options.ttl = value()
        break
      case "--memory":
        options.memory = Number(value())
        break
      case "--image":
        options.image = value()
        break
      case "--count":
        options.count = Number(value())
        break
      case "--concurrency":
        options.concurrency = Number(value())
        break
      case "--delete-all":
        options.deleteAll = value()
        break
      default:
        throw new Error(`unknown argument ${arg}`)
    }
  }
  if (options.reuse) options.name = options.reuse
  return options
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const PACKAGE_JSON = JSON.stringify(
  {
    name: "blaxel-large-app",
    version: "0.0.0",
    private: true,
    scripts: {
      build: "next build",
      start: `next start -H 0.0.0.0 -p ${APP_PORT}`,
    },
  },
  null,
  2,
)

const NEXT_CONFIG = `const nextConfig = { typescript: { ignoreBuildErrors: true } };
export default nextConfig;
`

/**
 * Shared by the page and the API route: re-hash the sampled files recorded at
 * build time, so a request tells whether the filesystem still holds the app.
 */
const VERIFY_TS = `import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type Manifest = {
  builtAt: string;
  sizeMb: number;
  fileCount: number;
  stages: string[];
  samples: { path: string; sha256: string; bytes: number }[];
};

export type Verification = {
  ok: boolean;
  checkedAt: string;
  durationMs: number;
  manifest: Omit<Manifest, "samples">;
  samples: { path: string; ok: boolean; expected: string; actual?: string; error?: string }[];
};

const ROOT = ${JSON.stringify(APP_DIR)};

export async function verify(): Promise<Verification> {
  const startedAt = Date.now();
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, "manifest.json"), "utf8")) as Manifest;
  const samples = await Promise.all(
    manifest.samples.map(async (sample) => {
      try {
        const content = await fs.readFile(path.join(ROOT, sample.path));
        const actual = crypto.createHash("sha256").update(content).digest("hex");
        return { path: sample.path, ok: actual === sample.sha256, expected: sample.sha256, actual };
      } catch (e) {
        return { path: sample.path, ok: false, expected: sample.sha256, error: (e as Error).message };
      }
    }),
  );
  const { samples: _samples, ...rest } = manifest;
  return { ok: samples.every((s) => s.ok), checkedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, manifest: rest, samples };
}
`

const ROUTE_TS = `import { verify } from "../../verify";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = await verify();
  return Response.json(result, { status: result.ok ? 200 : 500 });
}
`

const LAYOUT_TSX = `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "monospace", padding: "2rem" }}>{children}</body>
    </html>
  );
}
`

const PAGE_TSX = `import { verify } from "./verify";

export const dynamic = "force-dynamic";

export default async function Page() {
  const result = await verify();
  return (
    <main>
      <h1>Blaxel large app</h1>
      <p>app on disk: {result.manifest.sizeMb} MB across {result.manifest.fileCount} files</p>
      <p>dependency stages: {result.manifest.stages.join(", ")}</p>
      <p>built at {result.manifest.builtAt}</p>
      <p>
        integrity of {result.samples.length} sampled files: {result.ok ? "OK" : "CORRUPTED"} (checked in {result.durationMs}ms)
      </p>
      <ul>
        {result.samples.filter((s) => !s.ok).map((s) => (
          <li key={s.path}>{s.path}: {s.error ?? "hash mismatch"}</li>
        ))}
      </ul>
    </main>
  );
}
`

type RunResult = { exitCode: number; logs: string }

/** Run a shell command in the sandbox and wait for it, however long it takes. */
async function run(
  sandbox: SandboxInstance,
  command: string,
  { timeoutMs = INSTALL_TIMEOUT_MS, cwd = APP_DIR }: { timeoutMs?: number; cwd?: string } = {},
): Promise<RunResult> {
  const name = `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  await sandbox.process.exec({
    name,
    command,
    workingDir: cwd,
    waitForCompletion: false,
    // Long installs must not be killed by the default 10 minute process
    // timeout, nor have the sandbox scaled to zero underneath them.
    keepAlive: true,
    timeout: 0,
  })
  const result = await sandbox.process.wait(name, { maxWait: timeoutMs, interval: 2000 })
  return { exitCode: result.exitCode ?? -1, logs: result.logs ?? "" }
}

async function runOrThrow(sandbox: SandboxInstance, command: string, options?: { timeoutMs?: number }): Promise<string> {
  const { exitCode, logs } = await run(sandbox, command, options)
  if (exitCode !== 0) throw new Error(`\`${command}\` exited with ${exitCode}:\n${logs}`)
  return logs
}

/** Size of a directory in the sandbox, in MB. */
async function sizeMb(sandbox: SandboxInstance, path: string): Promise<number> {
  const logs = await runOrThrow(sandbox, `du -sm ${path} | cut -f1`, { timeoutMs: 5 * 60 * 1000 })
  const mb = Number(logs.trim().split(/\s+/).pop())
  if (!Number.isFinite(mb)) throw new Error(`could not read the size of ${path} from: ${logs}`)
  return mb
}

/** The sandbox API is not routable the instant `create` resolves. */
async function waitForSandboxApi(sandbox: SandboxInstance): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await sandbox.fs.ls("/")
      return
    } catch (e) {
      if (i === 30) throw e
      await sleep(2000)
    }
  }
}

async function writeAppFiles(sandbox: SandboxInstance): Promise<void> {
  await sandbox.fs.write(`${APP_DIR}/package.json`, PACKAGE_JSON)
  await sandbox.fs.write(`${APP_DIR}/next.config.mjs`, NEXT_CONFIG)
  await sandbox.fs.write(`${APP_DIR}/app/verify.ts`, VERIFY_TS)
  await sandbox.fs.write(`${APP_DIR}/app/layout.tsx`, LAYOUT_TSX)
  await sandbox.fs.write(`${APP_DIR}/app/page.tsx`, PAGE_TSX)
  await sandbox.fs.write(`${APP_DIR}/app/api/verify/route.ts`, ROUTE_TS)
}

/** Install stages until the app on disk reaches the target size. */
async function installUntilTarget(
  sandbox: SandboxInstance,
  targetMb: number,
  log: (line: string) => void,
): Promise<{ stages: string[]; sizeMb: number }> {
  const stages: string[] = []
  let size = 0
  for (const stage of STAGES) {
    const startedAt = Date.now()
    log(`  installing ${stage.label}: ${stage.packages.join(" ")}`)
    const env = Object.entries(stage.env ?? {})
      .map(([key, value]) => `${key}=${value} `)
      .join("")
    await runOrThrow(sandbox, `${env}npm install --no-audit --no-fund --loglevel=error ${stage.packages.join(" ")}`)
    stages.push(stage.label)
    size = await sizeMb(sandbox, APP_DIR)
    log(`    ${size}MB after ${stage.label} (${Math.round((Date.now() - startedAt) / 1000)}s)`)
    if (size >= targetMb) return { stages, sizeMb: size }
  }
  log(`  ⚠️  every stage installed and the app is only ${size}MB, short of the ${targetMb}MB target`)
  return { stages, sizeMb: size }
}

/**
 * Record the app's size and the sha256 of files sampled across it, so the
 * served app can prove the filesystem survived an archive/restore.
 */
async function writeManifest(
  sandbox: SandboxInstance,
  stages: string[],
  size: number,
  log: (line: string) => void,
): Promise<number> {
  const fileCount = Number(
    (await runOrThrow(sandbox, `find . -type f | wc -l`, { timeoutMs: 5 * 60 * 1000 })).trim().split(/\s+/).pop(),
  )
  // Spread the samples over the tree (every nth file) rather than taking the
  // first n, which would all sit in the same directory.
  const sampled = await runOrThrow(
    sandbox,
    // Only package payload files: package-lock.json, .next/ and npm's own
    // node_modules/.package-lock.json or .cache are rewritten by later installs
    // and by the build, and would report a false corruption.
    `find ./node_modules -type f -size +1k -not -path '*/.*' | awk 'NR % 251 == 1' | head -40 | xargs sha256sum`,
    { timeoutMs: 5 * 60 * 1000 },
  )
  const samples = sampled
    .split("\n")
    .map((line) => line.trim().match(/^([0-9a-f]{64})\s+(.+)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ path: m[2], sha256: m[1], bytes: 0 }))
  if (samples.length === 0) throw new Error(`no sampled files to check integrity with:\n${sampled}`)

  await sandbox.fs.write(
    `${APP_DIR}/manifest.json`,
    JSON.stringify({ builtAt: new Date().toISOString(), sizeMb: size, fileCount, stages, samples }, null, 2),
  )
  log(`  manifest: ${fileCount} files, ${samples.length} integrity samples`)
  return fileCount
}

type Probe = { ok: boolean; status: number; durationMs: number; detail: string }

/** GET the preview's verify endpoint, on a connection of its own. */
async function probe(url: string): Promise<Probe> {
  const startedAt = Date.now()
  try {
    const response = await fetch(`${url}/api/verify`, {
      headers: { connection: "close" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    const body = await response.text()
    const durationMs = Date.now() - startedAt
    if (!response.ok) return { ok: false, status: response.status, durationMs, detail: body.slice(0, 400) }
    const parsed = JSON.parse(body) as { ok: boolean; manifest: { sizeMb: number; fileCount: number }; samples: { path: string; ok: boolean; error?: string }[] }
    const broken = parsed.samples.filter((s) => !s.ok)
    return {
      ok: parsed.ok,
      status: response.status,
      durationMs,
      detail: parsed.ok
        ? `${parsed.manifest.sizeMb}MB / ${parsed.manifest.fileCount} files, ${parsed.samples.length} samples intact`
        : `${broken.length}/${parsed.samples.length} samples broken: ${broken.map((s) => `${s.path} (${s.error ?? "hash mismatch"})`).join(", ")}`,
    }
  } catch (e) {
    return { ok: false, status: 0, durationMs: Date.now() - startedAt, detail: (e as Error).message }
  }
}

async function waitUntilServing(url: string): Promise<Probe> {
  let last: Probe = { ok: false, status: 0, durationMs: 0, detail: "never probed" }
  for (let i = 0; i < 60; i++) {
    last = await probe(url)
    if (last.ok) return last
    await sleep(5000)
  }
  throw new Error(`the preview never served the app: ${last.status} ${last.detail}`)
}

type RunOutcome = {
  name: string
  url?: string
  sizeMb?: number
  servedMs?: number
  restoreMs?: number
  integrity?: string
  error?: string
}

/**
 * Build (or reuse), serve and check one sandbox. `log` is prefixed with the
 * sandbox name when several run at once.
 */
async function runOne(options: Options, name: string, log: (line: string) => void): Promise<RunOutcome> {
  let created = false
  const outcome: RunOutcome = { name }

  try {
    let sandbox: SandboxInstance
    if (options.reuse) {
      log(`Reusing sandbox ${name}...`)
      sandbox = await SandboxInstance.get(name)
    } else {
      log(`Creating sandbox ${name} (${options.memory}MB, ttl ${options.ttl})...`)
      sandbox = await SandboxInstance.create({
        name,
        image: options.image,
        memory: options.memory,
        ttl: options.ttl,
        ports: [{ target: APP_PORT, protocol: "HTTP" }],
        labels: { "created-by": "large_app_preview", env: "manual-test" },
      })
      created = true
      await waitForSandboxApi(sandbox)

      log(`Writing the app to ${APP_DIR}...`)
      await writeAppFiles(sandbox)

      log(`Installing dependencies until the app reaches ${options.targetMb}MB...`)
      const installed = await installUntilTarget(sandbox, options.targetMb, log)
      await writeManifest(sandbox, installed.stages, installed.sizeMb, log)

      log("Building the app...")
      const buildStartedAt = Date.now()
      await runOrThrow(sandbox, "npm run build", { timeoutMs: BUILD_TIMEOUT_MS })
      log(`  built in ${Math.round((Date.now() - buildStartedAt) / 1000)}s`)
    }

    log("Starting the app...")
    await sandbox.process.exec({
      name: "large-app",
      command: "npm run start",
      workingDir: APP_DIR,
      waitForCompletion: false,
      waitForPorts: [APP_PORT],
      restartOnFailure: true,
      maxRestarts: -1,
      // Only hold the sandbox up when asked: the archive system needs it to be
      // allowed to go to standby.
      keepAlive: options.keepAlive,
      timeout: 0,
    })

    const previews = await sandbox.previews.list()
    const preview =
      previews.find((p) => p.name === PREVIEW_NAME) ??
      (await sandbox.previews.create({ metadata: { name: PREVIEW_NAME }, spec: { port: APP_PORT, public: true } }))
    const url = preview.spec?.url
    if (!url) throw new Error("the preview has no URL")

    const first = await waitUntilServing(url)
    const total = await sizeMb(sandbox, APP_DIR)
    outcome.url = url
    outcome.sizeMb = total
    outcome.servedMs = first.durationMs
    outcome.integrity = first.detail

    log("--- the app is live ---")
    log(`preview:      ${url}`)
    log(`app on disk:  ${total}MB (${APP_DIR})`)
    log(`integrity:    ${first.detail}`)
    log(`served in:    ${first.durationMs}ms`)

    if (options.idleMin > 0) {
      log(`Staying silent for ${options.idleMin} minutes so the sandbox goes to standby and is archived...`)
      await sleep(options.idleMin * 60 * 1000)
      log("Probing the preview again — this request has to restore the filesystem:")
      const restored = await probe(url)
      log(`  answered in ${Math.round(restored.durationMs / 1000)}s (${restored.durationMs}ms): ${restored.detail}`)
      // A second probe on the now-warm sandbox separates restore cost from the
      // app's own response time.
      const warm = await probe(url)
      log(`  warm request: ${warm.durationMs}ms`)
      outcome.restoreMs = restored.durationMs
      outcome.integrity = restored.detail
      if (!restored.ok) {
        outcome.error = `broken after the archive: ${restored.detail}`
        log(`❌ The app came back broken after the archive: ${restored.detail}`)
        return outcome
      }
      log(`✅ ${total}MB of app survived the archive; the first request after it took ${restored.durationMs}ms.`)
      return outcome
    }

    log(
      `✅ Ready. Leave it idle to have it archived, then check the restore with:\n` +
        `   npx tsx tests/manual/large_app_preview.ts --reuse ${name} --idle-min 20`,
    )
    return outcome
  } catch (e) {
    outcome.error = (e as Error).message
    log(`❌ ${outcome.error}`)
    return outcome
  } finally {
    if (options.del && (created || options.reuse)) {
      log("🧹 Deleting the sandbox...")
      try {
        await SandboxInstance.delete(name)
        log(`  deleted ${name}`)
      } catch (e) {
        log(`  failed to delete ${name}: ${(e as Error).message}`)
      }
    } else if (created) {
      log(`The sandbox ${name} is left running (ttl ${options.ttl}). Delete it with:`)
      log(`   npx tsx tests/manual/large_app_preview.ts --reuse ${name} --delete`)
    }
  }
}

/** Delete every sandbox this script created whose name starts with `prefix`. */
async function deleteAll(prefix: string): Promise<void> {
  // `PaginatedList` is not exported from the package's entrypoint.
  const page: Awaited<ReturnType<typeof SandboxInstance.list>> = await SandboxInstance.list()
  const names: string[] = []
  await page.autoPagingEach((sandbox: SandboxInstance) => {
    const name = sandbox.metadata?.name
    if (name && name.startsWith(prefix) && sandbox.metadata?.labels?.["created-by"] === "large_app_preview") {
      names.push(name)
    }
  })
  if (names.length === 0) {
    console.log(`No sandbox created by this script starts with "${prefix}".`)
    return
  }
  console.log(`Deleting ${names.length} sandbox(es) starting with "${prefix}"...`)
  for (const name of names) {
    try {
      await SandboxInstance.delete(name)
      console.log(`  deleted ${name}`)
    } catch (e) {
      console.warn(`  failed to delete ${name}: ${(e as Error).message}`)
    }
  }
}

/** Run `tasks` with at most `limit` of them in flight at any time. */
async function pooled<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results = new Array<T>(tasks.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    while (next < tasks.length) {
      const index = next++
      results[index] = await tasks[index]()
    }
  })
  await Promise.all(workers)
  return results
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.deleteAll !== undefined) {
    await deleteAll(options.deleteAll)
    return
  }

  const base = options.reuse ?? options.name
  if (options.reuse && options.del && options.count === 1) {
    console.log(`Deleting sandbox ${base}...`)
    await SandboxInstance.delete(base)
    console.log("  deleted")
    return
  }

  if (options.count === 1) {
    const outcome = await runOne(options, base, (line) => console.log(line))
    if (outcome.error) process.exitCode = 1
    return
  }

  const names = Array.from({ length: options.count }, (_, i) => `${base}-${i + 1}`)
  console.log(`Building ${options.count} sandboxes (${options.concurrency} at a time): ${names.join(", ")}\n`)
  const startedAt = Date.now()
  const outcomes = await pooled(
    names.map((name) => () => runOne(options, name, (line) => console.log(`[${name}] ${line}`))),
    options.concurrency,
  )

  console.log(`\n--- ${outcomes.length} sandboxes in ${Math.round((Date.now() - startedAt) / 1000)}s ---`)
  for (const outcome of outcomes) {
    const status = outcome.error ? `❌ ${outcome.error}` : `✅ ${outcome.sizeMb}MB — ${outcome.integrity}`
    const restore = outcome.restoreMs === undefined ? "" : ` — restored in ${outcome.restoreMs}ms`
    console.log(`${outcome.name}: ${status}${restore}`)
    if (outcome.url) console.log(`  ${outcome.url}`)
  }
  const failed = outcomes.filter((o) => o.error)
  if (failed.length > 0) {
    console.error(`\n${failed.length}/${outcomes.length} failed.`)
    process.exitCode = 1
    return
  }
  if (!options.del) {
    console.log(`\nDelete the whole batch with:\n   npx tsx tests/manual/large_app_preview.ts --delete-all ${base}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
