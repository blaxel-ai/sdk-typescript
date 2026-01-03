/**
 * Integration test for Image build functionality.
 *
 * This test builds and deploys a custom image as a sandbox and verifies the process.
 *
 * @vitest-environment node
 */

import { describe, it, expect, afterAll } from 'vitest'
import { ImageInstance, SandboxInstance, deleteSandbox } from "@blaxel/core"
import { uniqueName, waitForSandboxDeletion } from './helpers'

describe('Image Build Integration', () => {
  const createdSandboxes: string[] = []

  afterAll(async () => {
    // Clean up all sandboxes
    for (const name of createdSandboxes) {
      try {
        await deleteSandbox({ path: { sandboxName: name } })
        await waitForSandboxDeletion(name)
        console.log(`✅ Cleanup complete for ${name}`)
      } catch {
        // Ignore cleanup errors
      }
    }
  })

  function printStatus(status: string): void {
    const statusIcons: Record<string, string> = {
      "UPLOADING": "📤",
      "BUILDING": "🔨",
      "DEPLOYING": "🚀",
      "DEPLOYED": "✅",
      "FAILED": "❌",
      "TERMINATED": "🛑",
    }
    const icon = statusIcons[status] || "📋"
    console.log(`  ${icon} Status: ${status}`)
  }

  it('builds and deploys advanced image with rebuild', async () => {
    console.log("\n" + "=".repeat(60))
    console.log("Advanced Image Build Test")
    console.log("=".repeat(60))

    const sandboxName = uniqueName("image-test")
    createdSandboxes.push(sandboxName)

    // Create a comprehensive image with multiple features
    const image = ImageInstance.fromRegistry("python:3.11-slim")
      .runCommands(
        "apt-get update && apt-get install -y --no-install-recommends curl git wget && rm -rf /var/lib/apt/lists/*"
      )
      .workdir("/app")
      .runCommands("pip install --no-cache-dir requests httpx pydantic")
      .env({
        PYTHONUNBUFFERED: "1",
        APP_NAME: "blaxel-test",
        DEBUG: "true",
        LOG_LEVEL: "info",
      })
      .label({
        maintainer: "blaxel",
        version: "1.0.0",
        description: "Integration test image",
      })
      .runCommands(
        "python --version",
        "curl --version",
        "git --version"
      )
      .copy(".", "/app")
      .expose(8080)

    console.log(`📦 Building advanced image as sandbox: ${sandboxName}`)
    console.log(`   Base image: ${image.baseImage}`)
    console.log(`   Dockerfile hash: ${image.hash}`)
    console.log(`\n📄 User-defined Dockerfile:\n${"-".repeat(40)}`)
    console.log(image.dockerfile)
    console.log("-".repeat(40))

    // Show what the prepared image looks like (with sandbox-api injected)
    // @ts-expect-error - accessing private method for testing
    const prepared = image._prepareForSandbox("latest")
    console.log(`\n📄 Final Dockerfile (with sandbox-api):\n${"-".repeat(40)}`)
    console.log(prepared.dockerfile)
    console.log("-".repeat(40))

    // Build and deploy
    const sandbox = await image.build({
      name: sandboxName,
      memory: 4096,
      timeout: 900000,
      onStatusChange: printStatus,
      sandboxVersion: "latest",
    })

    console.log(`\n✅ Build successful!`)
    console.log(`   Sandbox name: ${sandbox.metadata?.name}`)
    console.log(`   Status: ${sandbox.status}`)

    expect(sandbox.metadata?.name).toBe(sandboxName)
    expect(sandbox.status).toBe("DEPLOYED")

    // Verify the sandbox is accessible and packages work
    console.log("\n🔍 Verifying sandbox...")
    const sandboxInstance = await SandboxInstance.get(sandboxName)
    console.log(`   Sandbox exists: ${sandboxInstance.metadata?.name}`)

    // Test Python packages
    const pythonResult = await sandboxInstance.process.exec({
      command: "python -c \"import requests; import httpx; import pydantic; print('All packages OK')\"",
      waitForCompletion: true,
    })
    console.log(`   Python packages: ${pythonResult.logs?.trim() || 'N/A'}`)
    expect(pythonResult.logs).toContain("All packages OK")

    // Test apt packages
    const curlResult = await sandboxInstance.process.exec({
      command: "curl --version | head -1",
      waitForCompletion: true,
    })
    console.log(`   curl: ${curlResult.logs?.trim() || 'N/A'}`)
    expect(curlResult.logs).toContain("curl")

    // Test re-building the same image with the same name (update scenario)
    console.log("\n" + "=".repeat(60))
    console.log("Re-building same image (update scenario)")
    console.log("=".repeat(60))

    // Modify the image slightly to simulate an update
    const imageV2 = ImageInstance.fromRegistry("python:3.11-slim")
      .runCommands(
        "apt-get update && apt-get install -y --no-install-recommends curl git wget vim && rm -rf /var/lib/apt/lists/*"
      )
      .workdir("/app")
      .runCommands("pip install --no-cache-dir requests httpx pydantic aiohttp")
      .env({
        PYTHONUNBUFFERED: "1",
        APP_NAME: "blaxel-test",
        DEBUG: "true",
        LOG_LEVEL: "debug",
        VERSION: "2.0.0",
      })
      .label({
        maintainer: "blaxel",
        version: "2.0.0",
        description: "Integration test image v2",
      })
      .runCommands(
        "python --version",
        "curl --version",
        "git --version",
        "vim --version | head -1"
      )
      .copy(".", "/app")
      .expose(8080)

    console.log(`📦 Re-building updated image as sandbox: ${sandboxName}`)
    console.log(`   Dockerfile hash: ${imageV2.hash}`)

    const sandboxV2 = await imageV2.build({
      name: sandboxName,
      memory: 4096,
      timeout: 900000,
      onStatusChange: printStatus,
      sandboxVersion: "latest",
    })

    console.log(`\n✅ Re-build successful!`)
    console.log(`   Sandbox name: ${sandboxV2.metadata?.name}`)
    console.log(`   Status: ${sandboxV2.status}`)

    expect(sandboxV2.metadata?.name).toBe(sandboxName)
    expect(sandboxV2.status).toBe("DEPLOYED")

    // Verify the updated sandbox
    console.log("\n🔍 Verifying updated sandbox...")
    const sandboxInstanceV2 = await SandboxInstance.get(sandboxName)

    // Test new Python package (aiohttp)
    const aiohttpResult = await sandboxInstanceV2.process.exec({
      command: "python -c \"import aiohttp; print('aiohttp OK')\"",
      waitForCompletion: true,
    })
    console.log(`   aiohttp package: ${aiohttpResult.logs?.trim() || 'N/A'}`)
    expect(aiohttpResult.logs).toContain("aiohttp OK")

    // Test new apt package (vim)
    const vimResult = await sandboxInstanceV2.process.exec({
      command: "vim --version | head -1",
      waitForCompletion: true,
    })
    console.log(`   vim: ${vimResult.logs?.trim() || 'N/A'}`)
    expect(vimResult.logs).toContain("VIM")

    console.log("\n🎉 All verifications passed!")
    console.log("   - Initial build: OK")
    console.log("   - Re-build (update): OK")
  }, 1200000) // 20 minute timeout
})
