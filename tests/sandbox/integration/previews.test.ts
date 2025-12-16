import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { SandboxInstance, settings } from "@blaxel/core"
import { uniqueName, cleanupAll, sleep } from './helpers'

describe('Sandbox Preview Operations', () => {
  let sandbox: SandboxInstance
  const sandboxName = uniqueName("preview-test")

  beforeAll(async () => {
    // Use nextjs image for preview tests (has a server)
    sandbox = await SandboxInstance.create({
      name: sandboxName,
      image: "blaxel/nextjs:latest",
      memory: 4096,
      ports: [
        { target: 3000 }
      ]
    })

    // Start the dev server
    await sandbox.process.exec({
      command: "npm run dev -- --port 3000",
      workingDir: "/blaxel/app",
      waitForPorts: [3000]
    })
  }, 180000) // 3 minute timeout for setup

  afterAll(async () => {
    try {
      await SandboxInstance.delete(sandboxName)
    } catch {
      // Ignore
    }
    await cleanupAll()
  })

  describe('create', () => {
    it('creates a public preview', async () => {
      const preview = await sandbox.previews.create({
        metadata: { name: "public-preview" },
        spec: {
          port: 3000,
          public: true
        }
      })

      expect(preview.metadata?.name).toBe("public-preview")
      expect(preview.spec?.url).toBeDefined()
      expect(preview.spec?.url).toContain("preview")

      await sandbox.previews.delete("public-preview")
    })

    it('creates a private preview', async () => {
      const preview = await sandbox.previews.create({
        metadata: { name: "private-preview" },
        spec: {
          port: 3000,
          public: false
        }
      })

      expect(preview.metadata?.name).toBe("private-preview")
      expect(preview.spec?.url).toBeDefined()

      await sandbox.previews.delete("private-preview")
    })

    it('creates preview with custom prefix URL', async () => {
      const preview = await sandbox.previews.create({
        metadata: { name: "prefix-preview" },
        spec: {
          port: 3000,
          prefixUrl: "my-custom-prefix",
          public: true
        }
      })

      expect(preview.spec?.url).toContain("my-custom-prefix")

      await sandbox.previews.delete("prefix-preview")
    })
  })

  describe('createIfNotExists', () => {
    it('creates new preview if not exists', async () => {
      const preview = await sandbox.previews.createIfNotExists({
        metadata: { name: "cine-preview" },
        spec: {
          port: 3000,
          public: true
        }
      })

      expect(preview.metadata?.name).toBe("cine-preview")

      await sandbox.previews.delete("cine-preview")
    })

    it('returns existing preview if already exists', async () => {
      // Create first
      await sandbox.previews.create({
        metadata: { name: "existing-preview" },
        spec: { port: 3000, public: true }
      })

      // Should return existing
      const second = await sandbox.previews.createIfNotExists({
        metadata: { name: "existing-preview" },
        spec: { port: 3000, public: true }
      })

      expect(second.metadata?.name).toBe("existing-preview")

      await sandbox.previews.delete("existing-preview")
    })
  })

  describe('get', () => {
    it('retrieves an existing preview', async () => {
      await sandbox.previews.create({
        metadata: { name: "get-preview" },
        spec: { port: 3000, public: true }
      })

      const preview = await sandbox.previews.get("get-preview")

      expect(preview.name).toBe("get-preview")
      expect(preview.spec?.url).toBeDefined()

      await sandbox.previews.delete("get-preview")
    })
  })

  describe('list', () => {
    it('lists all previews', async () => {
      await sandbox.previews.create({
        metadata: { name: "list-preview-1" },
        spec: { port: 3000, public: true }
      })
      await sandbox.previews.create({
        metadata: { name: "list-preview-2" },
        spec: { port: 3000, public: true }
      })

      const previews = await sandbox.previews.list()

      expect(previews.length).toBeGreaterThanOrEqual(2)
      const names = previews.map(p => p.name)
      expect(names).toContain("list-preview-1")
      expect(names).toContain("list-preview-2")

      await sandbox.previews.delete("list-preview-1")
      await sandbox.previews.delete("list-preview-2")
    })
  })

  describe('delete', () => {
    it('deletes a preview', async () => {
      await sandbox.previews.create({
        metadata: { name: "delete-preview" },
        spec: { port: 3000, public: true }
      })

      await sandbox.previews.delete("delete-preview")

      const previews = await sandbox.previews.list()
      const names = previews.map(p => p.name)
      expect(names).not.toContain("delete-preview")
    })
  })

  describe('public preview access', () => {
    it('public preview is accessible without token', async () => {
      const preview = await sandbox.previews.create({
        metadata: { name: "access-public" },
        spec: {
          port: 3000,
          public: true
        }
      })

      const response = await fetch(`${preview.spec?.url}`)
      expect(response.status).toBe(200)

      await sandbox.previews.delete("access-public")
    })
  })

  describe('private preview tokens', () => {
    it('private preview requires token', async () => {
      const preview = await sandbox.previews.create({
        metadata: { name: "token-required" },
        spec: {
          port: 3000,
          public: false
        }
      })

      const response = await fetch(preview.spec?.url!)
      expect(response.status).toBe(401)

      await sandbox.previews.delete("token-required")
    })

    it('creates and uses preview token', async () => {
      const preview = await sandbox.previews.create({
        metadata: { name: "token-test" },
        spec: {
          port: 3000,
          public: false
        }
      })

      // Create token (expires in 10 minutes)
      const expiration = new Date(Date.now() + 10 * 60 * 1000)
      const token = await preview.tokens.create(expiration)

      expect(token.value).toBeDefined()

      // Access with token
      const response = await fetch(
        `${preview.spec?.url}?bl_preview_token=${token.value}`
      )
      expect(response.status).toBe(200)

      await sandbox.previews.delete("token-test")
    })

    it('lists tokens', async () => {
      const preview = await sandbox.previews.create({
        metadata: { name: "list-tokens" },
        spec: { port: 3000, public: false }
      })

      const expiration = new Date(Date.now() + 10 * 60 * 1000)
      const token = await preview.tokens.create(expiration)

      const tokens = await preview.tokens.list()

      expect(tokens.length).toBeGreaterThan(0)
      expect(tokens.find(t => t.value === token.value)).toBeDefined()

      await sandbox.previews.delete("list-tokens")
    })

    it('deletes token', async () => {
      const preview = await sandbox.previews.create({
        metadata: { name: "delete-token" },
        spec: { port: 3000, public: false }
      })

      const expiration = new Date(Date.now() + 10 * 60 * 1000)
      const token = await preview.tokens.create(expiration)

      await preview.tokens.delete(token.value)

      const tokens = await preview.tokens.list()
      expect(tokens.find(t => t.value === token.value)).toBeUndefined()

      await sandbox.previews.delete("delete-token")
    })
  })

  describe('CORS headers', () => {
    it('sets custom CORS headers', async () => {
      const preview = await sandbox.previews.create({
        metadata: { name: "cors-test" },
        spec: {
          port: 3000,
          public: true,
          responseHeaders: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization"
          }
        }
      })

      const response = await fetch(preview.spec?.url!, {
        method: "OPTIONS",
        headers: {
          "Origin": "https://example.com",
          "Access-Control-Request-Method": "POST"
        }
      })

      expect(response.headers.get("access-control-allow-origin")).toBe("*")

      await sandbox.previews.delete("cors-test")
    })
  })
})
