// Sample: seed a Blaxel volume with data.
//
// Creates the volume (in the given region) if it doesn't already exist, mounts
// it on a throwaway sandbox in the same region, writes a small sample file tree
// onto it, then deletes the sandbox (the volume and its data persist).
//
// Pairs with volume_region_migration.ts: seed a volume here, then migrate it to
// another region there.
//
// Uses only public @blaxel/core primitives: VolumeInstance, SandboxInstance,
// sandbox.process (exec).
//
// Run (after `npm run build` in @blaxel/core):
//
//   BL_WORKSPACE=... BL_API_KEY=... \
//   VOLUME=my-vol REGION=us-was-1 \
//   npx tsx tests/manual/volume_seed.ts
//
// Env vars:
//   BL_WORKSPACE, BL_API_KEY   credentials (required)
//   VOLUME                     name of the volume to create/seed (required)
//   REGION                     region to create the volume in (default us-was-1)
//   SIZE_MB                    volume size in MB (default 1024)
//   FILES                      number of sample text files to write (default 5)
//   MOUNT_PATH                 where the volume is mounted while seeding (default /volume)
//   IMAGE                      sandbox image (default blaxel/base-image:latest)

// Disable H2 to work around PM-2160 (h2 stream unref -> event loop exits mid-await).
// Must be set BEFORE importing @blaxel/core.
process.env.BL_DISABLE_H2 = process.env.BL_DISABLE_H2 ?? "1"

import { SandboxInstance, VolumeInstance, settings } from "@blaxel/core"
import { v4 as uuidv4 } from "uuid"

const VOLUME = process.env.VOLUME
const REGION = process.env.REGION || "us-was-1"
const SIZE_MB = parseInt(process.env.SIZE_MB || "1024", 10)
const FILES = parseInt(process.env.FILES || "5", 10)
const MOUNT_PATH = process.env.MOUNT_PATH || "/volume"
const IMAGE = process.env.IMAGE || "blaxel/base-image:latest"
const LABELS = { env: "manual-test", "created-by": "volume-seed" }

const EXEC_TIMEOUT_S = 600

function uniqueName(prefix: string): string {
  return `${prefix}-${uuidv4().replace(/-/g, "").substring(0, 8)}`
}

function log(msg: string) {
  console.log(`[seed] ${msg}`)
}

// Run a command in the sandbox and fail loudly on a non-zero exit code.
async function run(sbx: SandboxInstance, command: string, label: string): Promise<string> {
  const result = await sbx.process.exec({ command, waitForCompletion: true, timeout: EXEC_TIMEOUT_S })
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed (exit ${result.exitCode}):\n${result.logs ?? ""}`)
  }
  return result.logs?.trim() ?? ""
}

async function main() {
  if (!settings.workspace) throw new Error("BL_WORKSPACE must be set")
  if (!process.env.BL_API_KEY) throw new Error("BL_API_KEY must be set")
  if (!VOLUME) throw new Error("VOLUME must be set (name of the volume to seed)")

  const t0 = Date.now()

  log(`creating volume ${VOLUME} (${SIZE_MB} MB) in ${REGION} if it doesn't exist`)
  await VolumeInstance.createIfNotExists({ name: VOLUME, size: SIZE_MB, region: REGION, labels: LABELS })

  const seederName = uniqueName("seeder")
  log(`creating sandbox ${seederName} in ${REGION} with ${VOLUME} mounted at ${MOUNT_PATH}`)
  const seeder = await SandboxInstance.create({
    name: seederName,
    image: IMAGE,
    region: REGION,
    labels: LABELS,
    volumes: [{ name: VOLUME, mountPath: MOUNT_PATH, readOnly: false }],
  })

  try {
    // Write a small, deterministic-ish tree: some text files, a nested dir, and
    // one binary blob so migration verification exercises more than plain text.
    const fileCmds = Array.from({ length: FILES }, (_, i) =>
      `echo 'sample file ${i} seeded in ${REGION}' > ${MOUNT_PATH}/data/file-${i}.txt`,
    ).join(" && ")

    log(`writing ${FILES} text file(s) + a 1 MiB binary blob`)
    await run(
      seeder,
      `mkdir -p ${MOUNT_PATH}/data ${MOUNT_PATH}/nested && ` +
        `${fileCmds} && ` +
        `echo 'nested file' > ${MOUNT_PATH}/nested/deep.txt && ` +
        `head -c 1048576 /dev/urandom > ${MOUNT_PATH}/data/blob.bin && ` +
        `sync`,
      "seed data",
    )

    const listing = await run(seeder, `cd ${MOUNT_PATH} && find . -type f | sort && echo '---' && du -sh .`, "list")
    log(`seeded ${VOLUME}:\n${listing}`)
    log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  } finally {
    log(`deleting seeder sandbox ${seederName} (volume data persists)`)
    await SandboxInstance.delete(seederName).catch(() => {})
  }
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
