/**
 * Integration test for Image build functionality.
 *
 * This test builds and deploys a custom image as a sandbox and verifies the process.
 *
 * @vitest-environment node
 */

import { describe, it, expect, afterAll } from 'vitest'
import { ImageInstance, SandboxInstance, deleteSandbox } from "@blaxel/core"
import { uniqueName, waitForSandboxDeletion } from './helpers.js'

const IMAGE_BUILD = process.env.IMAGE_BUILD === 'true'

describe.skipIf(!IMAGE_BUILD)('Image Build Integration', () => {
  const createdSandboxes: string[] = []

  afterAll(async () => {
    // Clean up all sandboxes
    for (const name of createdSandboxes) {
      try {
        await deleteSandbox({ path: { sandboxName: name } })
        await waitForSandboxDeletion(name)
        
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
    
  }

  it('builds and deploys advanced image with rebuild', async () => {
    
    
    

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

    
    
    
    
    
    

    // Show what the prepared image looks like (with sandbox-api injected)
    // @ts-expect-error - accessing private method for testing
    const prepared = image._prepareForSandbox("latest")
    
    
    

    // Build and deploy
    const sandbox = await image.build({
      name: sandboxName,
      memory: 4096,
      timeout: 900000,
      onStatusChange: printStatus,
      sandboxVersion: "latest",
    })

    
    
    

    expect(sandbox.metadata?.name).toBe(sandboxName)
    expect(sandbox.status).toBe("DEPLOYED")

    // Verify the sandbox is accessible and packages work
    
    const sandboxInstance = await SandboxInstance.get(sandboxName)
    

    // Test Python packages
    const pythonResult = await sandboxInstance.process.exec({
      command: "python -c \"import requests; import httpx; import pydantic; print('All packages OK')\"",
      waitForCompletion: true,
    })
    
    expect(pythonResult.logs).toContain("All packages OK")

    // Test apt packages
    const curlResult = await sandboxInstance.process.exec({
      command: "curl --version | head -1",
      waitForCompletion: true,
    })
    
    expect(curlResult.logs).toContain("curl")

    // Test re-building the same image with the same name (update scenario)
    
    
    

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

    
    

    const sandboxV2 = await imageV2.build({
      name: sandboxName,
      memory: 4096,
      timeout: 900000,
      onStatusChange: printStatus,
      sandboxVersion: "latest",
    })

    
    
    

    expect(sandboxV2.metadata?.name).toBe(sandboxName)
    expect(sandboxV2.status).toBe("DEPLOYED")

    // Verify the updated sandbox
    
    const sandboxInstanceV2 = await SandboxInstance.get(sandboxName)

    // Test new Python package (aiohttp)
    const aiohttpResult = await sandboxInstanceV2.process.exec({
      command: "python -c \"import aiohttp; print('aiohttp OK')\"",
      waitForCompletion: true,
    })
    
    expect(aiohttpResult.logs).toContain("aiohttp OK")

    // Test new apt package (vim)
    const vimResult = await sandboxInstanceV2.process.exec({
      command: "vim --version | head -1",
      waitForCompletion: true,
    })
    
    expect(vimResult.logs).toContain("VIM")

    
    
    
  }, 1200000) // 20 minute timeout

  it('builds with worker memory and volume like bl push --memory/--volume', async () => {
    const sandboxName = uniqueName("image-resources")
    createdSandboxes.push(sandboxName)

    const sandbox = await ImageInstance.fromRegistry("alpine:3.20").build({
      name: sandboxName,
      memory: 2048,
      timeout: 900000,
      onStatusChange: printStatus,
      buildMemory: 8192,
      buildVolume: 16384,
    })

    expect(sandbox.status).toBe("DEPLOYED")
    expect(sandbox.metadata?.labels?.["x-blaxel-build-memory"]).toBe("8192")
    expect(sandbox.metadata?.labels?.["x-blaxel-build-volume"]).toBe("16384")
  }, 1200000)
})
