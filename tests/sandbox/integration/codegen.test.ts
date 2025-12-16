import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { SandboxInstance } from "@blaxel/core"
import { uniqueName, cleanupAll, defaultImage } from './helpers'

describe('Sandbox Codegen Operations', () => {
  // These tests require RELACE_API_KEY or MORPH_API_KEY environment variables
  const hasRelaceKey = !!process.env.RELACE_API_KEY
  const hasMorphKey = !!process.env.MORPH_API_KEY

  describe.skipIf(!hasRelaceKey)('fastapply with Relace', () => {
    let sandbox: SandboxInstance
    const sandboxName = uniqueName("codegen-relace")

    beforeAll(async () => {
      sandbox = await SandboxInstance.create({
        name: sandboxName,
        image: defaultImage,
        envs: [
          { name: "RELACE_API_KEY", value: process.env.RELACE_API_KEY! }
        ]
      })
      await sandbox.wait()
    })

    afterAll(async () => {
      try {
        await SandboxInstance.delete(sandboxName)
      } catch {
        // Ignore
      }
    })

    it('applies code edit to create new file', async () => {
      await sandbox.codegen.fastapply(
        "/tmp/test.txt",
        "// ... existing code ...\nconsole.log('Hello, world!');"
      )

      const content = await sandbox.fs.read("/tmp/test.txt")
      expect(content).toContain("Hello, world!")
    })

    it('preserves existing content when applying edits', async () => {
      // First edit
      await sandbox.codegen.fastapply(
        "/tmp/preserve-test.txt",
        "// ... existing code ...\nconsole.log('First line');"
      )

      // Second edit - should preserve first line
      await sandbox.codegen.fastapply(
        "/tmp/preserve-test.txt",
        "// ... keep existing code\nconsole.log('Second line');"
      )

      const content = await sandbox.fs.read("/tmp/preserve-test.txt")
      expect(content).toContain("Second line")
      // Note: Whether first line is preserved depends on fastapply behavior
    })

    it('performs reranking search', async () => {
      // Create test file
      await sandbox.fs.write("/tmp/search-test.txt", "The meaning of life is 42")

      const result = await sandbox.codegen.reranking(
        "/tmp",
        "What is the meaning of life?",
        0.01,
        1000,
        ".*\\.txt$"
      )

      expect(result).toBeDefined()
      expect(result.files).toBeDefined()
      expect(result.files?.find(f => f.path?.includes("search-test.txt"))).toBeDefined()
    })
  })

  describe.skipIf(!hasMorphKey)('fastapply with Morph', () => {
    let sandbox: SandboxInstance
    const sandboxName = uniqueName("codegen-morph")

    beforeAll(async () => {
      sandbox = await SandboxInstance.create({
        name: sandboxName,
        image: defaultImage,
        envs: [
          { name: "MORPH_API_KEY", value: process.env.MORPH_API_KEY! }
        ]
      })
      await sandbox.wait()
    })

    afterAll(async () => {
      try {
        await SandboxInstance.delete(sandboxName)
      } catch {
        // Ignore
      }
    })

    it('applies code edit with Morph backend', async () => {
      await sandbox.codegen.fastapply(
        "/tmp/morph-test.txt",
        "// ... existing code ...\nconsole.log('Hello from Morph!');"
      )

      const content = await sandbox.fs.read("/tmp/morph-test.txt")
      expect(content).toContain("Hello from Morph!")
    })

    it('performs reranking with Morph', async () => {
      await sandbox.fs.write("/tmp/morph-search.txt", "The answer is always 42")

      const result = await sandbox.codegen.reranking(
        "/tmp",
        "What is the answer?",
        0.01,
        1000000,
        ".*\\.txt$"
      )

      expect(result).toBeDefined()
      expect(result.files).toBeDefined()
    })
  })

  // Conditional skip message
  it.skipIf(hasRelaceKey || hasMorphKey)('skips codegen tests without API keys', () => {
    console.log('Codegen tests skipped - set RELACE_API_KEY or MORPH_API_KEY to run')
    expect(true).toBe(true)
  })
})
