import { DriveInstance, SandboxInstance, VolumeInstance } from "@blaxel/core"
import { inspect } from "node:util"
import { v4 as uuidv4 } from "uuid"

const DEFAULT_IMAGES = [
  "blaxel/base-image:latest",
  "blaxel/py-app:latest",
  "blaxel/ts-app:latest",
  "blaxel/node:latest",
  "blaxel/nextjs:latest",
  "blaxel/vite:latest",
  "blaxel/astro:latest",
  "blaxel/expo:latest",
  "blaxel/chromium:latest",
  "blaxel/lightpanda:latest",
]

function positiveIntFromEnv(name: string, defaultValue: number): number {
  const value = Number.parseInt(process.env[name] || "", 10)
  return Number.isFinite(value) && value > 0 ? value : defaultValue
}

const IMAGES = (process.env.IMAGES?.split(",").map((image) => image.trim()).filter(Boolean) ?? DEFAULT_IMAGES).slice(0, 10)
const REGION = process.env.BL_REGION || "eu-fra-1"
const MEMORY_MB = positiveIntFromEnv("MEMORY_MB", 2048)
const VOLUME_SIZE_MB = positiveIntFromEnv("VOLUME_SIZE_MB", 1024)
const DRIVE_SIZE_GB = positiveIntFromEnv("DRIVE_SIZE_GB", 1)
const PARALLEL = positiveIntFromEnv("PARALLEL", 3)
const TTL = process.env.TTL || "2h"
const CLEANUP = process.env.CLEANUP === "true"
const VERIFY = process.env.VERIFY !== "false"
const LABELS = { env: "manual-test", "created-by": "catalog-images-test" }
const VOLUME_MOUNT_PATH = "/data"
const DRIVE_MOUNT_PATH = "/mnt/shared"

type CatalogImageResult = {
  name: string
  image: string
  success: boolean
  createDurationMs: number | null
  verifyDurationMs: number | null
  error?: string
}

type ResourceResult = {
  kind: "volume" | "drive"
  names: string[]
  success: boolean
  error?: string
}

function uniqueNameFromImage(image: string): string {
  const imageName = image.split("/").pop()?.replace(/[^a-z0-9-]/gi, "-").toLowerCase() || "image"
  return `catalog-${imageName.replace(/-latest$/, "")}-${uuidv4().replace(/-/g, "").substring(0, 8)}`
}

function uniqueName(prefix: string): string {
  return `${prefix}-${uuidv4().replace(/-/g, "").substring(0, 8)}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack || err.message
  }

  if (typeof err === "string") {
    return err
  }

  return inspect(err, { depth: 6, colors: false })
}

async function runOne(image: string, index: number): Promise<CatalogImageResult> {
  const name = uniqueNameFromImage(image)
  const tag = `[${index + 1}/${IMAGES.length} ${image}]`
  let sandbox: SandboxInstance | null = null
  let createDurationMs: number | null = null
  let verifyDurationMs: number | null = null

  try {
    console.log(`${tag} Creating sandbox ${name} in ${REGION}...`)
    const createStartedAt = Date.now()
    sandbox = await SandboxInstance.create({
      name,
      image,
      region: REGION,
      memory: MEMORY_MB,
      ttl: TTL,
      labels: LABELS,
    })
    createDurationMs = Date.now() - createStartedAt
    console.log(`${tag} Created in ${createDurationMs}ms`)

    if (VERIFY) {
      const verifyStartedAt = Date.now()
      const result = await sandbox.process.exec({
        command: `echo "hello from ${image}"`,
        waitForCompletion: true,
        timeout: 30,
      })
      verifyDurationMs = Date.now() - verifyStartedAt

      if (result.status && result.status !== "completed") {
        throw new Error(`verify command ended with status ${result.status}: ${result.stderr ?? result.logs ?? ""}`)
      }

      console.log(`${tag} Verified first exec in ${verifyDurationMs}ms`)
    }

    return { name, image, success: true, createDurationMs, verifyDurationMs }
  } catch (err: unknown) {
    const message = formatError(err)
    console.error(`${tag} ERROR: ${message}`)
    return { name, image, success: false, createDurationMs, verifyDurationMs, error: message }
  } finally {
    if (CLEANUP) {
      if (sandbox) {
        await sandbox.delete().catch((err: unknown) => {
          const message = formatError(err)
          console.error(`${tag} Cleanup failed for ${name}: ${message}`)
        })
      }
    }
  }
}

async function runVolumeSandbox(): Promise<ResourceResult> {
  const volumeName = uniqueName("catalog-volume")
  const sandboxName = uniqueName("catalog-volume-sbx")
  const tag = "[volume]"
  let sandbox: SandboxInstance | null = null
  let volumeCreated = false

  try {
    console.log(`${tag} Creating volume ${volumeName} (${VOLUME_SIZE_MB}MB) in ${REGION}...`)
    await VolumeInstance.create({ name: volumeName, size: VOLUME_SIZE_MB, region: REGION, labels: LABELS })
    volumeCreated = true

    console.log(`${tag} Creating sandbox ${sandboxName} with volume mounted at ${VOLUME_MOUNT_PATH}...`)
    sandbox = await SandboxInstance.create({
      name: sandboxName,
      image: "blaxel/base-image:latest",
      region: REGION,
      memory: MEMORY_MB,
      ttl: TTL,
      labels: LABELS,
      volumes: [{ name: volumeName, mountPath: VOLUME_MOUNT_PATH, readOnly: false }],
    })

    if (VERIFY) {
      const result = await sandbox.process.exec({
        command: `echo volume-ok > ${VOLUME_MOUNT_PATH}/catalog-volume-test.txt && cat ${VOLUME_MOUNT_PATH}/catalog-volume-test.txt`,
        waitForCompletion: true,
        timeout: 30,
      })
      if (result.status && result.status !== "completed") {
        throw new Error(`volume verify command ended with status ${result.status}: ${result.stderr ?? result.logs ?? ""}`)
      }
      if (!result.logs?.includes("volume-ok")) {
        throw new Error(`volume verify command did not return expected output: ${result.logs ?? "(no output)"}`)
      }
      console.log(`${tag} Verified write/read on ${VOLUME_MOUNT_PATH}`)
    }

    return { kind: "volume", names: [volumeName, sandboxName], success: true }
  } catch (err: unknown) {
    const message = formatError(err)
    console.error(`${tag} ERROR: ${message}`)
    return { kind: "volume", names: [volumeName, sandboxName], success: false, error: message }
  } finally {
    if (CLEANUP) {
      if (sandbox) {
        await sandbox.delete().catch((err: unknown) => {
          const message = formatError(err)
          console.error(`${tag} Cleanup failed for sandbox ${sandboxName}: ${message}`)
        })
      } else {
        console.log(`${tag} Skipping sandbox cleanup; ${sandboxName} was not created`)
      }

      if (volumeCreated) {
        await sleep(3_000)
        await VolumeInstance.delete(volumeName).catch((err: unknown) => {
          const message = formatError(err)
          console.error(`${tag} Cleanup failed for volume ${volumeName}: ${message}`)
        })
      }
    }
  }
}

async function runSharedDriveSandboxes(): Promise<ResourceResult> {
  const driveName = uniqueName("catalog-drive")
  const firstSandboxName = uniqueName("catalog-drive-a")
  const secondSandboxName = uniqueName("catalog-drive-b")
  const tag = "[drive]"
  const sandboxes: SandboxInstance[] = []
  let driveCreated = false

  try {
    console.log(`${tag} Creating drive ${driveName} (${DRIVE_SIZE_GB}GB) in ${REGION}...`)
    await DriveInstance.create({ name: driveName, size: DRIVE_SIZE_GB, region: REGION, labels: LABELS })
    driveCreated = true

    console.log(`${tag} Creating two sandboxes connected to drive ${driveName}...`)
    sandboxes.push(await SandboxInstance.create({
      name: firstSandboxName,
      image: "blaxel/base-image:latest",
      region: REGION,
      memory: MEMORY_MB,
      ttl: TTL,
      labels: LABELS,
    }))
    sandboxes.push(await SandboxInstance.create({
      name: secondSandboxName,
      image: "blaxel/base-image:latest",
      region: REGION,
      memory: MEMORY_MB,
      ttl: TTL,
      labels: LABELS,
    }))

    await Promise.all(
      sandboxes.map((sandbox) =>
        sandbox.drives.mount({ driveName, mountPath: DRIVE_MOUNT_PATH })
      )
    )
    console.log(`${tag} Mounted ${driveName} at ${DRIVE_MOUNT_PATH} on both sandboxes`)

    if (VERIFY) {
      const mountsBySandbox = await Promise.all(sandboxes.map((sandbox) => sandbox.drives.list()))
      for (const [index, mounts] of mountsBySandbox.entries()) {
        const found = mounts.find((mount) => mount.driveName === driveName && mount.mountPath === DRIVE_MOUNT_PATH)
        if (!found) {
          throw new Error(`drive mount not found on sandbox ${index + 1}: ${inspect(mounts, { depth: 6, colors: false })}`)
        }
      }

      await Promise.all(
        sandboxes.map(async (sandbox, index) => {
          const marker = `drive-${index + 1}-ok`
          const result = await sandbox.process.exec({
            command: `echo ${marker} > ${DRIVE_MOUNT_PATH}/catalog-drive-${index + 1}-test.txt && cat ${DRIVE_MOUNT_PATH}/catalog-drive-${index + 1}-test.txt`,
            waitForCompletion: true,
            timeout: 30,
          })
          if (result.status && result.status !== "completed") {
            throw new Error(`drive write/read command on sandbox ${index + 1} ended with status ${result.status}: ${result.stderr ?? result.logs ?? ""}`)
          }
          if (!result.logs?.includes(marker)) {
            throw new Error(`drive write/read on sandbox ${index + 1} did not return expected output: ${result.logs ?? "(no output)"}`)
          }
        })
      )
      console.log(`${tag} Verified drive is mounted and writable on both sandboxes`)
    }

    return { kind: "drive", names: [driveName, firstSandboxName, secondSandboxName], success: true }
  } catch (err: unknown) {
    const message = formatError(err)
    console.error(`${tag} ERROR: ${message}`)
    return { kind: "drive", names: [driveName, firstSandboxName, secondSandboxName], success: false, error: message }
  } finally {
    if (CLEANUP) {
      await Promise.all(
        sandboxes.map((sandbox) =>
          sandbox.delete().catch((err: unknown) => {
            const message = formatError(err)
            console.error(`${tag} Cleanup failed for sandbox ${sandbox.metadata.name}: ${message}`)
          })
        )
      )
      if (driveCreated) {
        await sleep(3_000)
        await DriveInstance.delete(driveName).catch((err: unknown) => {
          const message = formatError(err)
          console.error(`${tag} Cleanup failed for drive ${driveName}: ${message}`)
        })
      }
    }
  }
}

async function main() {
  console.log("\nCatalog Images Sandbox Test")
  console.log(`  Images:   ${IMAGES.length}`)
  console.log(`  Region:   ${REGION}`)
  console.log(`  Memory:   ${MEMORY_MB}MB`)
  console.log(`  Volume:   ${VOLUME_SIZE_MB}MB`)
  console.log(`  Drive:    ${DRIVE_SIZE_GB}GB`)
  console.log(`  Parallel: ${PARALLEL}`)
  console.log(`  Verify:   ${VERIFY}`)
  console.log(`  Cleanup:  ${CLEANUP ? "enabled (CLEANUP=true)" : "disabled (default; set CLEANUP=true to delete)"}`)
  console.log()

  if (IMAGES.length !== 10) {
    throw new Error(`Expected 10 images, got ${IMAGES.length}. Set IMAGES to a comma-separated list of 10 catalog images.`)
  }

  const results: CatalogImageResult[] = []
  const queue = IMAGES.map((image, index) => ({ image, index }))

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift()
      if (!item) return
      results.push(await runOne(item.image, item.index))
    }
  }

  const workerCount = Math.min(PARALLEL, IMAGES.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  console.log("\nResource Attachment Tests")
  const resourceResults = await Promise.all([
    runVolumeSandbox(),
    runSharedDriveSandboxes(),
  ])

  const passed = results.filter((result) => result.success)
  const failed = results.filter((result) => !result.success)
  const passedResources = resourceResults.filter((result) => result.success)
  const failedResources = resourceResults.filter((result) => !result.success)

  console.log(`\n${"=".repeat(72)}`)
  console.log("RESULTS")
  console.log(`${"=".repeat(72)}`)
  console.log(`  Image sandboxes passed: ${passed.length}/${results.length}`)
  console.log(`  Image sandboxes failed: ${failed.length}/${results.length}`)
  console.log(`  Resource tests passed:  ${passedResources.length}/${resourceResults.length}`)
  console.log(`  Resource tests failed:  ${failedResources.length}/${resourceResults.length}`)

  for (const result of results.sort((a, b) => IMAGES.indexOf(a.image) - IMAGES.indexOf(b.image))) {
    const create = result.createDurationMs === null ? "create=n/a" : `create=${result.createDurationMs}ms`
    const verify = result.verifyDurationMs === null ? "verify=n/a" : `verify=${result.verifyDurationMs}ms`
    const suffix = result.error ? ` error=${result.error}` : ""
    console.log(`  - ${result.success ? "OK" : "FAIL"} ${result.image} (${result.name}) ${create} ${verify}${suffix}`)
  }

  for (const result of resourceResults) {
    const suffix = result.error ? ` error=${result.error}` : ""
    console.log(`  - ${result.success ? "OK" : "FAIL"} ${result.kind} resources=${result.names.join(", ")}${suffix}`)
  }

  if (failed.length > 0 || failedResources.length > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error("Fatal error:", formatError(err))
  process.exit(1)
})
