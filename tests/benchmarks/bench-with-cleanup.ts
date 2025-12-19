#!/usr/bin/env node --experimental-strip-types

import { spawn } from "child_process"
import { SandboxInstance, VolumeInstance } from "@blaxel/core"

async function runBench() {
  const args = process.argv.slice(2)
  const benchArgs = ["vitest", "bench", "--run", ...args]

  return new Promise<number>((resolve) => {
    const child = spawn("npx", benchArgs, {
      stdio: "inherit",
      cwd: process.cwd(),
    })

    child.on("close", (code) => {
      resolve(code ?? 0)
    })
  })
}

async function cleanup() {
  console.log("\n🧹 Cleaning up benchmark resources...")

  try {
    // Cleanup sandboxes
    const sandboxes = await SandboxInstance.list()
    const benchSandboxes = sandboxes.filter(
      (s) =>
        s.metadata.labels?.env === "benchmark" &&
        s.metadata.labels?.language === "typescript"
    )

    if (benchSandboxes.length > 0) {
      console.log(`   Found ${benchSandboxes.length} benchmark sandbox(es)`)

      const deletePromises = benchSandboxes.map(async (s) => {
        const name = s.metadata.name
        if (name) {
          try {
            await SandboxInstance.delete(name)
            console.log(`   ✓ Deleted sandbox: ${name}`)
          } catch (error) {
            console.log(`   ⚠️  Failed to delete sandbox ${name}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      })

      await Promise.all(deletePromises)
    }

    // Cleanup volumes
    const volumes = await VolumeInstance.list()
    const benchVolumes = volumes.filter((v) => v.name?.startsWith("bench-"))

    if (benchVolumes.length > 0) {
      console.log(`   Found ${benchVolumes.length} benchmark volume(s)`)

      const deletePromises = benchVolumes.map(async (v) => {
        const name = v.name
        if (name) {
          try {
            await VolumeInstance.delete(name)
            console.log(`   ✓ Deleted volume: ${name}`)
          } catch (error) {
            console.log(`   ⚠️  Failed to delete volume ${name}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      })

      await Promise.all(deletePromises)
    }

    if (benchSandboxes.length === 0 && benchVolumes.length === 0) {
      console.log("   ✓ No benchmark resources to clean up")
    } else {
      console.log("✓ Cleanup complete")
    }
  } catch (error) {
    console.log(`⚠️  Cleanup error: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function main() {
  const exitCode = await runBench()
  await cleanup()
  process.exit(exitCode)
}

void main()
