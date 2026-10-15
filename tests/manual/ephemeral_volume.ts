// Sample: create a sandbox with an ephemeral (disk-backed scratch) volume.
//
// Ephemeral volumes are created together with the sandbox on the mk3.1
// (Firecracker) generation and live only for the sandbox's lifetime. Unlike
// persistent volumes, there is no Volume resource to create beforehand: you
// just declare the attachment with `type: "ephemeral"` and a `sizeMb`.
//
// This script intentionally does NOT delete the sandbox, so you can inspect the
// mounted scratch disk manually (e.g. via `df -h` / writing files under the
// mount path). Delete it yourself when done:
//
//   npx tsx -e "import('@blaxel/core').then(m => m.SandboxInstance.delete('<name>'))"
//
// Requires the `generation_mk31` feature flag enabled on the workspace.
// Credentials are picked up automatically via @blaxel/core autoload (local
// config / env), so BL_WORKSPACE / BL_API_KEY are not required here.
//
// Run (after `npm run build` in @blaxel/core):
//
//   npx tsx tests/manual/ephemeral_volume.ts
//
// Env vars:
//   NAME                       sandbox name (default: ephemeral-<random>)
//   VOLUME                     ephemeral volume name (default: scratch)
//   SIZE_MB                    ephemeral volume size in MB (default 1024)
//   MOUNT_PATH                 where the volume is mounted (default /scratch)
//   REGION                     region to create the sandbox in (optional)
//   IMAGE                      sandbox image (default blaxel/base-image:latest)

// Disable H2 to work around PM-2160 (h2 stream unref -> event loop exits mid-await).
// Must be set BEFORE importing @blaxel/core.
process.env.BL_DISABLE_H2 = process.env.BL_DISABLE_H2 ?? "1"

import { SandboxInstance } from "@blaxel/core"
import { v4 as uuidv4 } from "uuid"

const VOLUME = process.env.VOLUME || "scratch"
const SIZE_MB = parseInt(process.env.SIZE_MB || "1024", 10)
const MOUNT_PATH = process.env.MOUNT_PATH || "/scratch"
const REGION = process.env.REGION
const IMAGE = process.env.IMAGE || "blaxel/base-image:latest"
const LABELS = { env: "manual-test", "created-by": "ephemeral-volume" }

const EXEC_TIMEOUT_S = 600

function uniqueName(prefix: string): string {
  return `${prefix}-${uuidv4().replace(/-/g, "").substring(0, 8)}`
}

function log(msg: string) {
  console.log(`[ephemeral] ${msg}`)
}

async function run(sbx: SandboxInstance, command: string, label: string): Promise<string> {
  const result = await sbx.process.exec({ command, waitForCompletion: true, timeout: EXEC_TIMEOUT_S })
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed (exit ${result.exitCode}):\n${result.logs ?? ""}`)
  }
  return result.logs?.trim() ?? ""
}

async function main() {
  const name = process.env.NAME || uniqueName("ephemeral")
  const t0 = Date.now()

  log(`creating sandbox ${name} with ephemeral volume ${VOLUME} (${SIZE_MB} MB) at ${MOUNT_PATH}`)
  const sandbox = await SandboxInstance.create({
    name,
    image: IMAGE,
    ...(REGION ? { region: REGION } : {}),
    labels: LABELS,
    volumes: [
      {
        name: VOLUME,
        mountPath: MOUNT_PATH,
        type: "ephemeral",
        sizeMb: SIZE_MB,
      },
    ],
  })

  log(`sandbox ${name} is ready — checking the mounted scratch disk`)

  const dfOut = await run(sandbox, `df -h ${MOUNT_PATH} || df -h`, "df")
  log(`df:\n${dfOut}`)

  await run(sandbox, `echo 'hello from ephemeral volume' > ${MOUNT_PATH}/hello.txt && sync`, "write")
  const catOut = await run(sandbox, `cat ${MOUNT_PATH}/hello.txt`, "read")
  log(`wrote and read back: ${catOut}`)

  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  log(`sandbox ${name} was left running for manual inspection — remember to delete it when done.`)
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
