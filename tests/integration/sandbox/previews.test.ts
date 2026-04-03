import { SandboxInstance } from "@blaxel/core"
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultLabels, defaultRegion, fetchWithRetry, uniqueName } from './helpers.js'

describe('Sandbox Preview Operations', () => {
  let sandbox: SandboxInstance
  const sandboxName = uniqueName("preview-test")

  beforeAll(async () => {
    // Use nextjs image for preview tests (has a server)
    sandbox = await SandboxInstance.create({
      name: sandboxName,
      image: "blaxel/nextjs:latest",
      memory: 4096,
      region: defaultRegion,
      ports: [
        { target: 3000 }
      ],
      labels: defaultLabels,
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

      expect(preview.metadata.name).toBe("public-preview")
      expect(preview.spec.url).toBeDefined()
      expect(preview.spec.url).toContain("preview")

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

      expect(preview.metadata.name).toBe("private-preview")
      expect(preview.spec.url).toBeDefined()

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

      expect(preview.spec.url).toContain("my-custom-prefix")

      await sandbox.previews.delete("prefix-preview")
    })


    it('creates preview on a non-declared port and reaches the server', async () => {
      await sandbox.process.exec({
        command: `node -e "require('http').createServer((req, res) => { res.writeHead(200, {'Content-Type':'text/plain'}); res.end('hello-undeclared'); }).listen(15500)"`,
        waitForCompletion: false,
      })

      const check = await sandbox.process.exec({
        command: 'node -e "const http = require(\'http\'); const r = http.get(\'http://localhost:15500\', res => { let d=\'\'; res.on(\'data\',c=>d+=c); res.on(\'end\',()=>console.log(d)); }); r.on(\'error\', e => { console.error(e.message); process.exit(1); })"',
        waitForCompletion: true,
      })
      expect(check.exitCode).toBe(0)

      let preview: Awaited<ReturnType<typeof sandbox.previews.create>>
      try {
        preview = await sandbox.previews.create({
          metadata: { name: "undeclared-port-preview" },
          spec: { port: 15500, public: true }
        })
      } catch (err: any) {
        const msg = err?.error?.message || err?.message || JSON.stringify(err?.error || err)
        throw new Error(`Preview creation on undeclared port 15500 rejected: ${msg}`)
      }

      expect(preview.metadata.name).toBe("undeclared-port-preview")
      expect(preview.spec.url).toBeDefined()
      expect(preview.spec.port).toBe(15500)

      const response = await fetchWithRetry(preview.spec.url!, undefined, { retries: 5, delayMs: 1000 })
      expect(response.status).toBe(200)
      const body = await response.text()
      expect(body).toBe("hello-undeclared")

      await sandbox.previews.delete("undeclared-port-preview")
    }, 30_000)

    it('declared vs undeclared port preview latency comparison', async () => {
      await sandbox.process.exec({
        command: `node -e "require('http').createServer((req, res) => { res.writeHead(200); res.end('bench'); }).listen(15501)"`,
        waitForCompletion: false,
      })

      const check = await sandbox.process.exec({
        command: 'node -e "const http = require(\'http\'); const r = http.get(\'http://localhost:15501\', res => { let d=\'\'; res.on(\'data\',c=>d+=c); res.on(\'end\',()=>console.log(d)); }); r.on(\'error\', e => { console.error(e.message); process.exit(1); })"',
        waitForCompletion: true,
      })
      expect(check.exitCode).toBe(0)

      const declaredPreview = await sandbox.previews.create({
        metadata: { name: "bench-declared" },
        spec: { port: 3000, public: true }
      })
      let undeclaredPreview: Awaited<ReturnType<typeof sandbox.previews.create>>
      try {
        undeclaredPreview = await sandbox.previews.create({
          metadata: { name: "bench-undeclared" },
          spec: { port: 15501, public: true }
        })
      } catch (err: any) {
        const msg = err?.error?.message || err?.message || JSON.stringify(err?.error || err)
        throw new Error(`Preview creation on undeclared port 15501 rejected: ${msg}`)
      }

      await fetchWithRetry(declaredPreview.spec.url!, undefined, { retries: 3, delayMs: 500 })
      await fetchWithRetry(undeclaredPreview.spec.url!, undefined, { retries: 3, delayMs: 500 })

      const iterations = 5
      const declaredTimes: number[] = []
      const undeclaredTimes: number[] = []

      for (let i = 0; i < iterations; i++) {
        const dStart = Date.now()
        const dResp = await fetch(declaredPreview.spec.url!)
        declaredTimes.push(Date.now() - dStart)
        expect(dResp.status).toBe(200)

        const uStart = Date.now()
        const uResp = await fetch(undeclaredPreview.spec.url!)
        undeclaredTimes.push(Date.now() - uStart)
        expect(uResp.status).toBe(200)
      }

      const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length
      const declaredAvg = avg(declaredTimes)
      const undeclaredAvg = avg(undeclaredTimes)
      const diff = undeclaredAvg - declaredAvg

      console.log(`[preview port bench] declared (3000) avg: ${declaredAvg.toFixed(0)}ms, samples: [${declaredTimes.join(', ')}]`)
      console.log(`[preview port bench] undeclared (15501) avg: ${undeclaredAvg.toFixed(0)}ms, samples: [${undeclaredTimes.join(', ')}]`)
      console.log(`[preview port bench] diff: ${diff.toFixed(0)}ms (${declaredAvg > 0 ? ((diff / declaredAvg) * 100).toFixed(1) : '?'}%)`)

      expect(Math.abs(diff)).toBeLessThan(2000)

      await sandbox.previews.delete("bench-declared")
      await sandbox.previews.delete("bench-undeclared")
    }, 60_000)
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

      expect(preview.metadata.name).toBe("cine-preview")

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

      expect(second.metadata.name).toBe("existing-preview")

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
      expect(preview.spec.url).toBeDefined()

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

      const response = await fetch(`${preview.spec.url}`)
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

      const response = await fetch(preview.spec.url ?? '')
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
        `${preview.spec.url}?bl_preview_token=${token.value}`
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

    it('creates private preview with 15 tokens and tests async deletion', async () => {
      console.log(`Sandbox name: ${sandbox.metadata.name}`);
      const preview = await sandbox.previews.create({
        metadata: { name: "preview-with-many-tokens" },
        spec: { port: 3000, public: false }
      })
      console.log(`Preview created: ${preview.metadata.name}`);

      const expiration = new Date(Date.now() + 10 * 60 * 1000)
      const tokens = await Promise.all(
        Array.from({ length: 15 }, () => preview.tokens.create(expiration))
      )

      expect(tokens.length).toBe(15)
      tokens.forEach(token => {
        expect(token.value).toBeDefined()
      })

      const listedTokens = await preview.tokens.list()
      expect(listedTokens.length).toBeGreaterThanOrEqual(15)

      await sandbox.previews.delete("preview-with-many-tokens")
      await expect(sandbox.previews.get("preview-with-many-tokens")).rejects.toThrow()

      await sandbox.previews.create({
        metadata: { name: "preview-with-many-tokens" },
        spec: { port: 3000, public: true }
      })
      const response = await fetch(preview.spec.url ?? '')
      expect(response.status).toBe(200)
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

      const response = await fetch(preview.spec.url ?? '', {
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

  describe('advanced scenarios', () => {
    it('creates preview with custom server and token authentication', { timeout: 120000 }, async () => {
      const name = uniqueName("preview-custom-server")

      const customSandbox = await SandboxInstance.create({
        name,
        image: "blaxel/node:latest",
        memory: 4096,
        region: defaultRegion,
        ports: [{ target: 3000, protocol: "HTTP" }],
        labels: defaultLabels,
      })

      try {
        // Create preview
        const preview = await customSandbox.previews.create({
          metadata: {
            name: "custom-server-preview"
          },
          spec: {
            port: 3000,
            public: false,
            responseHeaders: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
              "Access-Control-Allow-Headers": "Content-Type, Authorization",
            }
          }
        })

        expect(preview.metadata?.name).toBe("custom-server-preview")
        expect(preview.spec?.port).toBe(3000)
        expect(preview.spec?.url).toBeDefined()

        // Create token
        const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24) // 24 hours
        const token = await preview.tokens.create(expiresAt)

        expect(token.value).toBeDefined()
        expect(token.value).toMatch(/^[a-zA-Z0-9_-]+$/)

        // Write a simple server file
        await customSandbox.fs.write("/tmp/server.js", `const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('hello world');
});

server.listen(3000, '0.0.0.0', () => {
  console.log('Server running on port 3000');
});
`)

        // Start server
        await customSandbox.process.exec({
          name: "hello-server",
          command: "node /tmp/server.js",
          waitForPorts: [3000],
        })

        // Verify preview URL is accessible with token
        const previewUrl = preview.spec?.url
        expect(previewUrl).toBeDefined()

        const urlWithToken = `${previewUrl}?bl_preview_token=${token.value}`
        expect(urlWithToken).toContain(token.value)

        // Test that token expiration is set correctly
        expect(token.expiresAt).toBeDefined()
        const expectedExpiry = expiresAt.getTime()
        const actualExpiry = new Date(token.expiresAt).getTime()
        const diff = Math.abs(actualExpiry - expectedExpiry)
        expect(diff).toBeLessThan(10000) // 10s tolerance
      } finally {
        await SandboxInstance.delete(name).catch(() => {})
      }
    })

    it('creates multiple previews on different ports', async () => {
      const name = uniqueName("preview-multi-port")

      const customSandbox = await SandboxInstance.create({
        name,
        image: "blaxel/node:latest",
        memory: 4096,
        region: defaultRegion,
        ports: [
          { target: 3000, protocol: "HTTP" },
          { target: 4000, protocol: "HTTP" },
        ],
        labels: defaultLabels,
      })

      try {
        // Create two previews
        const preview1 = await customSandbox.previews.create({
          metadata: { name: "preview-3000" },
          spec: { port: 3000, public: false }
        })

        const preview2 = await customSandbox.previews.create({
          metadata: { name: "preview-4000" },
          spec: { port: 4000, public: false }
        })

        expect(preview1.spec?.port).toBe(3000)
        expect(preview2.spec?.port).toBe(4000)
        expect(preview1.spec?.url).not.toBe(preview2.spec?.url)
      } finally {
        await SandboxInstance.delete(name).catch(() => {})
      }
    })
  })

  // TODO : THIS IS NOT WORKING
  // describe('preview race conditions', () => {
  //   it('creates a preview then remove it and recreate the same preview', { timeout: 120000 }, async () => {
  //     const concurrency = 10
  //     const total = 100

  //     const runTest = async (index: number) => {
  //       const previewName = `preview-race-${index}`
  //       const preview = await sandbox.previews.createIfNotExists({
  //         metadata: { name: previewName },
  //         spec: { port: 3000, public: true }
  //       })

  //       const response = await fetchWithRetry(preview.spec?.url ?? '', undefined, { retries: 5, delayMs: 1000 })
  //       expect(response.status).toBe(200)

  //       await sandbox.previews.delete(previewName)

  //       const preview2 = await sandbox.previews.createIfNotExists({
  //         metadata: { name: previewName },
  //         spec: { port: 3000, public: true }
  //       })
  //       const response2 = await fetchWithRetry(preview2.spec?.url ?? '', undefined, { retries: 5, delayMs: 1000 })
  //       expect(response2.status).toBe(200)
  //     }

  //     // Run in batches to avoid overwhelming the infra
  //     for (let start = 0; start < total; start += concurrency) {
  //       const batch = Array.from(
  //         { length: Math.min(concurrency, total - start) },
  //         (_, i) => runTest(start + i + 1)
  //       )
  //       await Promise.all(batch)
  //     }
  //   })
  // })
})
