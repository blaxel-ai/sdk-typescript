// Sample: migrate a Blaxel volume from one region to another.
//
// There is no first-class "move volume across regions" API. This script shows
// the supported building blocks: a volume can only be attached to a sandbox in
// its own region, so we bridge two regions by round-tripping the data through a
// zip archive on the machine running this script:
//
//   1. attach the SOURCE volume to a sandbox in the source region
//   2. zip its contents inside that sandbox  ->  "download as zip"
//      (pull the archive to this machine with sandbox.fs.download)
//   3. attach the DESTINATION volume to a sandbox in the destination region
//   4. upload the archive into that sandbox  ->  "upload as zip"
//      (push it with sandbox.fs.writeBinary) and unzip it onto the volume
//
// It uses only public @blaxel/core primitives: VolumeInstance, SandboxInstance,
// sandbox.fs (download / writeBinary) and sandbox.process (exec).
//
// Run (from @blaxel/core, after `npm run build`):
//
//   BL_WORKSPACE=... BL_API_KEY=... \
//   SOURCE_VOLUME=my-vol SOURCE_REGION=us-was-1 \
//   DEST_REGION=eu-dub-1 \
//   npx tsx ../../tests/manual/volume_region_migration.ts
//
// Env vars:
//   BL_WORKSPACE, BL_API_KEY   credentials (required)
//   SOURCE_VOLUME              name of the volume to migrate.
//                              If unset, the script seeds a throwaway demo
//                              volume with sample files so it is self-contained.
//   SOURCE_REGION              region the source volume lives in (default us-was-1)
//   DEST_VOLUME                name of the destination volume
//                              (default: "<source>-<destRegion>")
//   DEST_REGION               target region (default eu-dub-1)
//   MOUNT_PATH                where volumes are mounted in the sandboxes (default /volume)
//   IMAGE                     sandbox image (default blaxel/base-image:latest)
//   KEEP_RESOURCES=1          skip cleanup of the sandboxes created here

// Disable H2 to work around PM-2160 (h2 stream unref -> event loop exits mid-await).
// Must be set BEFORE importing @blaxel/core.
process.env.BL_DISABLE_H2 = process.env.BL_DISABLE_H2 ?? "1"

import { SandboxInstance, VolumeInstance, settings } from "@blaxel/core"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { v4 as uuidv4 } from "uuid"

const SOURCE_VOLUME = process.env.SOURCE_VOLUME
const SOURCE_REGION = process.env.SOURCE_REGION || "us-was-1"
const DEST_REGION = process.env.DEST_REGION || "eu-dub-1"
const DEST_VOLUME = process.env.DEST_VOLUME || (SOURCE_VOLUME ? `${SOURCE_VOLUME}-${DEST_REGION}` : `demo-vol-${DEST_REGION}`)
const MOUNT_PATH = process.env.MOUNT_PATH || "/volume"
const IMAGE = process.env.IMAGE || "blaxel/base-image:latest"
const KEEP_RESOURCES = process.env.KEEP_RESOURCES === "1"
const LABELS = { env: "manual-test", "created-by": "volume-region-migration" }

// Archive lives on tmpfs inside the sandbox; the local copy in a temp dir.
const ARCHIVE_REMOTE = "/tmp/volume-migration.zip"

// Process timeout is in SECONDS (0 = infinite). Generous, since zipping a
// large volume can take a while.
const EXEC_TIMEOUT_S = 3600

function uniqueName(prefix: string): string {
  return `${prefix}-${uuidv4().replace(/-/g, "").substring(0, 8)}`
}

function log(msg: string) {
  console.log(`[migrate] ${msg}`)
}

// Run a command in the sandbox and fail loudly on a non-zero exit code.
async function run(sbx: SandboxInstance, command: string, label: string): Promise<string> {
  const result = await sbx.process.exec({ command, waitForCompletion: true, timeout: EXEC_TIMEOUT_S })
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed (exit ${result.exitCode}):\n${result.logs ?? ""}`)
  }
  return result.logs?.trim() ?? ""
}

// zip/unzip may not be preinstalled; install them once per sandbox.
async function ensureZipTools(sbx: SandboxInstance) {
  await run(
    sbx,
    "command -v zip >/dev/null && command -v unzip >/dev/null || " +
      "(apt-get update -qq && apt-get install -y -qq zip unzip >/dev/null 2>&1) || " +
      "(apk add --no-cache zip unzip >/dev/null 2>&1)",
    "install zip/unzip",
  )
}

// A stable fingerprint of a directory's contents (relative paths + sha256 of
// each file), used to prove the destination matches the source after migration.
async function fingerprint(sbx: SandboxInstance, dir: string): Promise<string> {
  return run(
    sbx,
    `cd ${dir} && find . -type f -not -path './.blaxel/*' -exec sha256sum {} + | sort -k2`,
    "fingerprint",
  )
}

async function ensureDestinationVolume(sourceSizeMb: number): Promise<void> {
  const existing = await VolumeInstance.list().then(
    (page) => page.data.find((v) => v.metadata?.name === DEST_VOLUME),
    () => undefined,
  )
  if (existing) {
    if (existing.spec?.region && existing.spec.region !== DEST_REGION) {
      throw new Error(
        `Destination volume ${DEST_VOLUME} already exists in region ${existing.spec.region}, not ${DEST_REGION}`,
      )
    }
    log(`destination volume ${DEST_VOLUME} already exists in ${DEST_REGION}`)
    return
  }
  log(`creating destination volume ${DEST_VOLUME} (${sourceSizeMb} MB) in ${DEST_REGION}`)
  await VolumeInstance.create({ name: DEST_VOLUME, size: sourceSizeMb, region: DEST_REGION, labels: LABELS })
}

// Create a throwaway source volume with sample data so the script runs
// end-to-end without a preexisting volume.
async function seedDemoSourceVolume(): Promise<{ name: string; sizeMb: number }> {
  const name = uniqueName("demo-src-vol")
  const sizeMb = 1024
  log(`no SOURCE_VOLUME provided — seeding demo volume ${name} in ${SOURCE_REGION}`)
  await VolumeInstance.create({ name, size: sizeMb, region: SOURCE_REGION, labels: LABELS })

  const seederName = uniqueName("seeder")
  const seeder = await SandboxInstance.create({
    name: seederName,
    image: IMAGE,
    region: SOURCE_REGION,
    labels: LABELS,
    volumes: [{ name, mountPath: MOUNT_PATH, readOnly: false }],
  })
  try {
    await run(
      seeder,
      `mkdir -p ${MOUNT_PATH}/data ${MOUNT_PATH}/nested && ` +
        `echo 'hello from ${SOURCE_REGION}' > ${MOUNT_PATH}/data/hello.txt && ` +
        `head -c 1048576 /dev/urandom > ${MOUNT_PATH}/data/blob.bin && ` +
        `echo 'nested file' > ${MOUNT_PATH}/nested/deep.txt && ` +
        `sync`,
      "seed data",
    )
    log(`seeded sample files into ${name}`)
  } finally {
    await SandboxInstance.delete(seederName).catch(() => {})
  }
  return { name, sizeMb }
}

async function main() {
  if (!settings.workspace) throw new Error("BL_WORKSPACE must be set")
  if (!process.env.BL_API_KEY) throw new Error("BL_API_KEY must be set")

  const t0 = Date.now()
  const localDir = mkdtempSync(join(tmpdir(), "bl-volmig-"))
  const localArchive = join(localDir, "volume.zip")
  const createdSandboxes: string[] = []

  let sourceVolume: string
  let sourceSizeMb: number

  if (SOURCE_VOLUME) {
    sourceVolume = SOURCE_VOLUME
    const vol = await VolumeInstance.get(SOURCE_VOLUME)
    sourceSizeMb = vol.size ?? 1024
    if (vol.region && vol.region !== SOURCE_REGION) {
      log(`note: source volume region is ${vol.region}; using it instead of ${SOURCE_REGION}`)
    }
  } else {
    const demo = await seedDemoSourceVolume()
    sourceVolume = demo.name
    sourceSizeMb = demo.sizeMb
  }

  await ensureDestinationVolume(sourceSizeMb)

  const sourceName = uniqueName("mig-source")
  const destName = uniqueName("mig-dest")

  try {
    // Volumes can only be attached at sandbox-create time, in their own region.
    log(`creating source sandbox (${SOURCE_REGION}) with ${sourceVolume} mounted read-only`)
    log(`creating dest sandbox   (${DEST_REGION}) with ${DEST_VOLUME} mounted read-write`)
    const [sourceSbx, destSbx] = await Promise.all([
      SandboxInstance.create({
        name: sourceName,
        image: IMAGE,
        region: SOURCE_REGION,
        labels: LABELS,
        volumes: [{ name: sourceVolume, mountPath: MOUNT_PATH, readOnly: true }],
      }),
      SandboxInstance.create({
        name: destName,
        image: IMAGE,
        region: DEST_REGION,
        labels: LABELS,
        volumes: [{ name: DEST_VOLUME, mountPath: MOUNT_PATH, readOnly: false }],
      }),
    ])
    createdSandboxes.push(sourceName, destName)

    await Promise.all([ensureZipTools(sourceSbx), ensureZipTools(destSbx)])

    // 1. Zip the volume contents inside the source sandbox.
    log("zipping source volume contents")
    await run(sourceSbx, `cd ${MOUNT_PATH} && rm -f ${ARCHIVE_REMOTE} && zip -r -q ${ARCHIVE_REMOTE} .`, "zip")
    const archiveSize = await run(sourceSbx, `stat -c '%s' ${ARCHIVE_REMOTE}`, "stat archive")
    log(`archive size: ${(parseInt(archiveSize, 10) / 1024 ** 2).toFixed(2)} MB`)

    const sourceFp = await fingerprint(sourceSbx, MOUNT_PATH)

    // 2. "Download as zip" — pull the archive to this machine.
    log(`downloading archive -> ${localArchive}`)
    await sourceSbx.fs.download(ARCHIVE_REMOTE, localArchive)

    // 3. "Upload as zip" — push the archive into the destination sandbox.
    //    writeBinary accepts a local file path in Node and uses multipart upload
    //    automatically for files > 5 MB.
    log("uploading archive to destination sandbox")
    await destSbx.fs.writeBinary(ARCHIVE_REMOTE, localArchive)

    // 4. Unzip onto the destination volume.
    log(`extracting archive onto ${DEST_VOLUME}`)
    await run(destSbx, `mkdir -p ${MOUNT_PATH} && unzip -o -q ${ARCHIVE_REMOTE} -d ${MOUNT_PATH} && sync`, "unzip")

    // 5. Verify the destination matches the source.
    const destFp = await fingerprint(destSbx, MOUNT_PATH)
    if (sourceFp !== destFp) {
      console.error("--- source fingerprint ---\n" + sourceFp)
      console.error("--- dest fingerprint ---\n" + destFp)
      throw new Error("verification FAILED: destination contents do not match source")
    }

    const fileCount = sourceFp ? sourceFp.split("\n").length : 0
    log(`verification OK — ${fileCount} file(s) match`)
    log(`migrated ${sourceVolume} (${SOURCE_REGION}) -> ${DEST_VOLUME} (${DEST_REGION}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  } finally {
    rmSync(localDir, { recursive: true, force: true })
    if (KEEP_RESOURCES) {
      log(`KEEP_RESOURCES=1 — leaving sandboxes alive: ${createdSandboxes.join(", ")}`)
    } else {
      log("cleaning up sandboxes")
      await Promise.all(createdSandboxes.map((n) => SandboxInstance.delete(n).catch(() => {})))
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
