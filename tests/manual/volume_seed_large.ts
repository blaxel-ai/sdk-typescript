/**
 * Seed volumes with a lot of real data (~1GB by default), in batch.
 *
 * Why: a volume with a handful of text files on it (what volume_seed.ts writes)
 * says nothing about how the platform behaves with a volume that actually holds
 * a workload — snapshotting it, migrating it across regions, mounting it on a
 * cold sandbox. This script fills a volume the way a user would: it mounts it on
 * a throwaway sandbox, `npm install`s heavy real packages onto it stage by stage
 * until the target size is reached, records a sha256 manifest of files sampled
 * across the tree, then throws the sandbox away. The volume and its data stay.
 *
 * Layout on the volume:
 *   <mount>/app/            the installed node app (this is where the weight is)
 *   <mount>/app/manifest.json  { seededAt, sizeMb, fileCount, stages, samples }
 *
 * Since seeding one volume is mostly waiting on npm, seeding is batched:
 * `--count 10` seeds ten volumes named <name>-1..<name>-10, `--concurrency 4`
 * of them at a time.
 *
 * `--verify` re-mounts already-seeded volumes and re-hashes the manifest samples
 * without writing anything — use it after a migration or a snapshot restore.
 *
 * Auth: whatever `bl login` left in ~/.blaxel, or BL_WORKSPACE + BL_API_KEY.
 *
 * Run:
 *   cd @blaxel/core && npm run build && cd ../..
 *   npx tsx tests/manual/volume_seed_large.ts --name seed --count 10
 *   npx tsx tests/manual/volume_seed_large.ts --name seed --count 10 --verify
 *   npx tsx tests/manual/volume_seed_large.ts --delete-all seed
 *
 * Options:
 *   --name <name>       volume name, or the prefix when --count > 1
 *                       (default seeded-vol-<random>)
 *   --count <n>         seed n volumes named <name>-1..<name>-n (default 1)
 *   --concurrency <n>   how many to seed in parallel (default 4)
 *   --target-mb <n>     data to write on each volume, in MB (default 1024)
 *   --size-mb <n>       volume size (default target + 1024 MB of headroom)
 *   --region <region>   region of the volumes and seeder sandboxes
 *                       (default us-was-1)
 *   --mount-path <p>    where the volume is mounted while seeding
 *                       (default /volume)
 *   --no-fill           stop at the last npm stage even if the target is not
 *                       reached, instead of padding with random files
 *   --verify            do not seed: mount each volume and re-check its manifest
 *   --keep-sandbox      keep the seeder sandbox at the end (for poking around)
 *   --delete-all <p>    delete every volume this script created whose name
 *                       starts with <p>, and do nothing else
 *   --image <image>     seeder sandbox image (default blaxel/base-image:latest)
 *   --memory <mb>       seeder sandbox memory (default 4096)
 */

// Disable H2 to work around PM-2160 (h2 stream unref -> event loop exits
// mid-await). Must be set BEFORE importing @blaxel/core.
process.env.BL_DISABLE_H2 = process.env.BL_DISABLE_H2 ?? "1"

import { SandboxInstance, VolumeInstance } from "@blaxel/core"

const CREATED_BY = "volume_seed_large"
const LABELS = { "created-by": CREATED_BY, env: "manual-test" }
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000
const CMD_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Heavy, well-known open source packages, in stages. Installed in order until
 * the target size is reached, biggest bang per install first. Versions are
 * pinned so a run's size is reproducible. Roughly 1.5GB once every stage is in.
 */
const STAGES: { label: string; packages: string[]; env?: (appDir: string) => Record<string, string> }[] = [
  { label: "next", packages: ["next@16.3.3", "react@19.2.8", "react-dom@19.2.8"] },
  { label: "toolchains", packages: ["typescript@5.9.3", "vite@8.2.2", "esbuild@0.28.2", "@swc/core@1.16.1", "webpack@5.109.2"] },
  { label: "sdks", packages: ["@aws-sdk/client-s3@3.1117.0", "sharp@0.35.3", "three@0.185.1", "rxjs@7.8.2"] },
  { label: "linters", packages: ["eslint@10.9.1", "prettier@3.9.6", "jest@30.4.2"] },
  { label: "angular", packages: ["@angular/cli@22.1.5", "playwright-core@1.62.1"] },
  // The heaviest stage: puppeteer downloads a full Chrome on install. Its cache
  // is redirected onto the volume, otherwise the browser lands in ~/.cache and
  // is not part of what is being seeded.
  { label: "chrome", packages: ["puppeteer@25.9.0"], env: (appDir) => ({ PUPPETEER_CACHE_DIR: `${appDir}/.cache/puppeteer` }) },
]

type Options = {
  name: string
  count: number
  concurrency: number
  targetMb: number
  sizeMb?: number
  region: string
  mountPath: string
  fill: boolean
  verify: boolean
  keepSandbox: boolean
  deleteAll?: string
  image: string
  memory: number
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    name: `seeded-vol-${Math.random().toString(36).slice(2, 8)}`,
    count: 1,
    concurrency: 4,
    targetMb: 1024,
    region: "us-was-1",
    mountPath: "/volume",
    fill: true,
    verify: false,
    keepSandbox: false,
    image: "blaxel/base-image:latest",
    memory: 4096,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${arg} needs a value`)
      return v
    }
    switch (arg) {
      case "--name":
        options.name = value()
        break
      case "--count":
        options.count = Number(value())
        break
      case "--concurrency":
        options.concurrency = Number(value())
        break
      case "--target-mb":
        options.targetMb = Number(value())
        break
      case "--size-mb":
        options.sizeMb = Number(value())
        break
      case "--region":
        options.region = value()
        break
      case "--mount-path":
        options.mountPath = value()
        break
      case "--no-fill":
        options.fill = false
        break
      case "--verify":
        options.verify = true
        break
      case "--keep-sandbox":
        options.keepSandbox = true
        break
      case "--delete-all":
        options.deleteAll = value()
        break
      case "--image":
        options.image = value()
        break
      case "--memory":
        options.memory = Number(value())
        break
      default:
        throw new Error(`unknown argument ${arg}`)
    }
  }
  return options
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function uniqueName(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`
}

/** The API rejects with plain objects (`{ code, error }`), not with Errors. */
function describeError(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === "object" && e !== null) {
    const { code, error, message } = e as { code?: unknown; error?: unknown; message?: unknown }
    const detail = error ?? message
    if (detail !== undefined) return code === undefined ? String(detail) : `${String(detail)} (${String(code)})`
    return JSON.stringify(e)
  }
  return String(e)
}

const PACKAGE_JSON = JSON.stringify({ name: "blaxel-volume-seed", version: "0.0.0", private: true }, null, 2)

type RunResult = { exitCode: number; logs: string }

/** Run a shell command in the sandbox and wait for it, however long it takes. */
async function run(sandbox: SandboxInstance, command: string, cwd: string, timeoutMs = CMD_TIMEOUT_MS): Promise<RunResult> {
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

async function runOrThrow(sandbox: SandboxInstance, command: string, cwd: string, timeoutMs?: number): Promise<string> {
  const { exitCode, logs } = await run(sandbox, command, cwd, timeoutMs)
  if (exitCode !== 0) throw new Error(`\`${command}\` exited with ${exitCode}:\n${logs}`)
  return logs
}

/** Size of a directory in the sandbox, in MB. */
async function sizeMb(sandbox: SandboxInstance, path: string): Promise<number> {
  const logs = await runOrThrow(sandbox, `du -sm ${path} | cut -f1`, "/", 5 * 60 * 1000)
  const mb = Number(logs.trim().split(/\s+/).pop())
  if (!Number.isFinite(mb)) throw new Error(`could not read the size of ${path} from: ${logs}`)
  return mb
}

/**
 * A volume is not mountable the instant `create` resolves: a sandbox created
 * against a volume that is still coming up fails with VOLUME_DELETED.
 */
async function waitForVolume(name: string, log: (line: string) => void): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const status = (await VolumeInstance.get(name)).status
    if (status === "DEPLOYED") return
    if (status === "FAILED" || status === "DELETING" || status === "TERMINATED") {
      throw new Error(`volume ${name} is ${status}`)
    }
    if (i === 0) log(`  waiting for ${name} to be mountable (${status ?? "no status"})`)
    await sleep(2000)
  }
  throw new Error(`volume ${name} never reached DEPLOYED`)
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

type Manifest = {
  seededAt: string
  region: string
  sizeMb: number
  fileCount: number
  stages: string[]
  samples: { path: string; sha256: string }[]
}

/** Install stages onto the volume until the app directory reaches the target. */
async function installUntilTarget(
  sandbox: SandboxInstance,
  appDir: string,
  targetMb: number,
  log: (line: string) => void,
): Promise<{ stages: string[]; sizeMb: number }> {
  const stages: string[] = []
  let size = 0
  for (const stage of STAGES) {
    const startedAt = Date.now()
    log(`  installing ${stage.label}: ${stage.packages.join(" ")}`)
    const env = Object.entries(stage.env?.(appDir) ?? {})
      .map(([key, value]) => `${key}=${value} `)
      .join("")
    // npm's cache lives on the volume too: the point is to write bytes there,
    // and it keeps the sandbox's own disk out of the picture.
    await runOrThrow(
      sandbox,
      `${env}npm install --cache ${appDir}/.npm-cache --no-audit --no-fund --loglevel=error ${stage.packages.join(" ")}`,
      appDir,
      INSTALL_TIMEOUT_MS,
    )
    stages.push(stage.label)
    size = await sizeMb(sandbox, appDir)
    log(`    ${size}MB on the volume after ${stage.label} (${Math.round((Date.now() - startedAt) / 1000)}s)`)
    if (size >= targetMb) return { stages, sizeMb: size }
  }
  return { stages, sizeMb: size }
}

/** Pad the volume with incompressible files until the target size is reached. */
async function fillToTarget(
  sandbox: SandboxInstance,
  appDir: string,
  targetMb: number,
  currentMb: number,
  log: (line: string) => void,
): Promise<number> {
  const missing = targetMb - currentMb
  log(`  padding with ${missing}MB of random files to reach ${targetMb}MB`)
  const chunkMb = 64
  const chunks = Math.ceil(missing / chunkMb)
  await runOrThrow(
    sandbox,
    `mkdir -p ${appDir}/filler && for i in $(seq 1 ${chunks}); do ` +
      `dd if=/dev/urandom of=${appDir}/filler/chunk-$i.bin bs=1M count=${chunkMb} status=none; done && sync`,
    appDir,
    INSTALL_TIMEOUT_MS,
  )
  return sizeMb(sandbox, appDir)
}

/**
 * Record the size and the sha256 of files sampled across the tree, so the data
 * on the volume can later be proven intact (after a migration, a snapshot
 * restore, or a mount on another sandbox).
 */
async function writeManifest(
  sandbox: SandboxInstance,
  appDir: string,
  region: string,
  stages: string[],
  size: number,
  log: (line: string) => void,
): Promise<Manifest> {
  const fileCount = Number((await runOrThrow(sandbox, `find . -type f | wc -l`, appDir, 5 * 60 * 1000)).trim().split(/\s+/).pop())
  // Spread the samples over the tree (every nth file) rather than taking the
  // first n, which would all sit in the same directory. The npm cache and the
  // dot-directories are skipped: npm rewrites them on the next install.
  const sampled = await runOrThrow(
    sandbox,
    `find . -type f -size +1k -not -path './.*' | awk 'NR % 251 == 1' | head -40 | xargs sha256sum`,
    appDir,
    5 * 60 * 1000,
  )
  const samples = sampled
    .split("\n")
    .map((line) => line.trim().match(/^([0-9a-f]{64})\s+(.+)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ path: m[2], sha256: m[1] }))
  if (samples.length === 0) throw new Error(`no sampled files to check integrity with:\n${sampled}`)

  const manifest: Manifest = {
    seededAt: new Date().toISOString(),
    region,
    sizeMb: size,
    fileCount,
    stages,
    samples,
  }
  await sandbox.fs.write(`${appDir}/manifest.json`, JSON.stringify(manifest, null, 2))
  log(`  manifest: ${fileCount} files, ${samples.length} integrity samples`)
  return manifest
}

/** Re-hash the manifest's samples from the volume as it is mounted right now. */
async function verifyManifest(
  sandbox: SandboxInstance,
  appDir: string,
): Promise<{ ok: boolean; manifest: Manifest; broken: string[]; sizeMb: number }> {
  const raw = await sandbox.fs.read(`${appDir}/manifest.json`)
  const manifest = JSON.parse(raw) as Manifest
  const actual = await runOrThrow(
    sandbox,
    `sha256sum ${manifest.samples.map((s) => `'${s.path}'`).join(" ")} 2>&1 || true`,
    appDir,
    5 * 60 * 1000,
  )
  const hashes = new Map(
    actual
      .split("\n")
      .map((line) => line.trim().match(/^([0-9a-f]{64})\s+(.+)$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => [m[2], m[1]] as const),
  )
  const broken = manifest.samples.filter((s) => hashes.get(s.path) !== s.sha256).map((s) => s.path)
  return { ok: broken.length === 0, manifest, broken, sizeMb: await sizeMb(sandbox, appDir) }
}

type Outcome = { volume: string; sizeMb?: number; fileCount?: number; seconds?: number; error?: string }

/** Seed (or verify) one volume, on a seeder sandbox of its own. */
async function seedOne(options: Options, volumeName: string, log: (line: string) => void): Promise<Outcome> {
  const outcome: Outcome = { volume: volumeName }
  const startedAt = Date.now()
  const appDir = `${options.mountPath}/app`
  const sandboxName = uniqueName(options.verify ? "verifier" : "seeder")
  let sandbox: SandboxInstance | undefined
  let createAttempted = false

  try {
    if (options.verify) {
      // Fail early and clearly rather than mounting a volume that isn't there.
      await VolumeInstance.get(volumeName)
    } else {
      const size = options.sizeMb ?? options.targetMb + 1024
      log(`creating volume ${volumeName} (${size}MB) in ${options.region} if it doesn't exist`)
      await VolumeInstance.createIfNotExists({
        name: volumeName,
        size,
        region: options.region,
        labels: LABELS,
      })
    }

    await waitForVolume(volumeName, log)

    log(`creating sandbox ${sandboxName} with ${volumeName} mounted at ${options.mountPath}`)
    createAttempted = true
    sandbox = await SandboxInstance.create({
      name: sandboxName,
      image: options.image,
      memory: options.memory,
      region: options.region,
      ttl: "1h",
      labels: LABELS,
      volumes: [{ name: volumeName, mountPath: options.mountPath, readOnly: false }],
    })
    await waitForSandboxApi(sandbox)

    if (options.verify) {
      const result = await verifyManifest(sandbox, appDir)
      outcome.sizeMb = result.sizeMb
      outcome.fileCount = result.manifest.fileCount
      if (!result.ok) throw new Error(`${result.broken.length}/${result.manifest.samples.length} samples broken: ${result.broken.join(", ")}`)
      log(`✅ ${result.sizeMb}MB / ${result.manifest.fileCount} files, ${result.manifest.samples.length} samples intact (seeded ${result.manifest.seededAt})`)
      outcome.seconds = Math.round((Date.now() - startedAt) / 1000)
      return outcome
    }

    await sandbox.fs.write(`${appDir}/package.json`, PACKAGE_JSON)
    log(`writing ${options.targetMb}MB onto ${volumeName} at ${appDir}`)
    const installed = await installUntilTarget(sandbox, appDir, options.targetMb, log)
    let total = installed.sizeMb
    if (total < options.targetMb) {
      if (options.fill) {
        total = await fillToTarget(sandbox, appDir, options.targetMb, total, log)
      } else {
        log(`  ⚠️  every stage installed and the volume only holds ${total}MB, short of the ${options.targetMb}MB target`)
      }
    }
    await runOrThrow(sandbox, "sync", appDir)
    const manifest = await writeManifest(sandbox, appDir, options.region, installed.stages, total, log)

    outcome.sizeMb = total
    outcome.fileCount = manifest.fileCount
    outcome.seconds = Math.round((Date.now() - startedAt) / 1000)
    log(`✅ seeded ${total}MB / ${manifest.fileCount} files in ${outcome.seconds}s`)
    return outcome
  } catch (e) {
    outcome.error = describeError(e) || "failed"
    log(`❌ ${outcome.error}`)
    return outcome
  } finally {
    // Delete on a failed create too: a sandbox that failed to deploy still
    // holds the volume attached, and the next run would be refused.
    if (createAttempted && !(sandbox && options.keepSandbox)) {
      log(`deleting sandbox ${sandboxName} (the volume and its data persist)`)
      await SandboxInstance.delete(sandboxName).catch((e: unknown) => log(`  failed to delete ${sandboxName}: ${describeError(e)}`))
    } else if (sandbox) {
      log(`sandbox ${sandboxName} left running with ${volumeName} mounted at ${options.mountPath} (ttl 1h)`)
    }
  }
}

/** Delete every volume this script created whose name starts with `prefix`. */
async function deleteAll(prefix: string): Promise<void> {
  const page: Awaited<ReturnType<typeof VolumeInstance.list>> = await VolumeInstance.list()
  const candidates: string[] = []
  await page.autoPagingEach((volume: VolumeInstance) => {
    const name = volume.metadata?.name
    if (name && name.startsWith(prefix)) candidates.push(name)
  })
  // The list endpoint does not return labels, so the ownership check needs a
  // GET per candidate — deleting a volume someone else seeded is not an option.
  const names: string[] = []
  for (const name of candidates) {
    const volume = await VolumeInstance.get(name)
    if (volume.metadata?.labels?.["created-by"] === CREATED_BY) names.push(name)
  }
  if (names.length === 0) {
    console.log(`No volume created by this script starts with "${prefix}".`)
    return
  }
  console.log(`Deleting ${names.length} volume(s) starting with "${prefix}"...`)
  for (const name of names) {
    try {
      await VolumeInstance.delete(name)
      console.log(`  deleted ${name}`)
    } catch (e) {
      console.warn(`  failed to delete ${name}: ${describeError(e)}`)
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

  const verb = options.verify ? "Verifying" : "Seeding"
  if (options.count === 1) {
    const outcome = await seedOne(options, options.name, (line) => console.log(line))
    if (outcome.error) process.exitCode = 1
    if (!options.verify && !outcome.error) {
      console.log(`\nVerify it later with:\n   npx tsx tests/manual/volume_seed_large.ts --name ${options.name} --verify`)
    }
    return
  }

  const names = Array.from({ length: options.count }, (_, i) => `${options.name}-${i + 1}`)
  console.log(`${verb} ${options.count} volumes (${options.concurrency} at a time): ${names.join(", ")}\n`)
  const startedAt = Date.now()
  const outcomes = await pooled(
    names.map((name) => () => seedOne(options, name, (line) => console.log(`[${name}] ${line}`))),
    options.concurrency,
  )

  console.log(`\n--- ${outcomes.length} volumes in ${Math.round((Date.now() - startedAt) / 1000)}s ---`)
  for (const outcome of outcomes) {
    console.log(
      outcome.error
        ? `${outcome.volume}: ❌ ${outcome.error}`
        : `${outcome.volume}: ✅ ${outcome.sizeMb}MB / ${outcome.fileCount} files in ${outcome.seconds}s`,
    )
  }
  const failed = outcomes.filter((o) => o.error)
  if (failed.length > 0) {
    console.error(`\n${failed.length}/${outcomes.length} failed.`)
    process.exitCode = 1
    return
  }
  if (!options.verify) {
    console.log(
      `\nVerify the batch with:\n   npx tsx tests/manual/volume_seed_large.ts --name ${options.name} --count ${options.count} --verify\n` +
        `Delete it with:\n   npx tsx tests/manual/volume_seed_large.ts --delete-all ${options.name}`,
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
