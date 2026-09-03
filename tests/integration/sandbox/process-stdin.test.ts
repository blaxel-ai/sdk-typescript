import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { SandboxInstance } from "@blaxel/core"
import { uniqueName, defaultImage, defaultLabels, defaultRegion } from './helpers.js'

// Collects raw stdout lines from the log stream and hands out JSON-RPC
// replies by id: what a stdio MCP client does on its side of the pipe.
function jsonRpcReader(sandbox: SandboxInstance, name: string) {
  const waiters = new Map<number, (msg: Record<string, unknown>) => void>()
  const seen = new Map<number, Record<string, unknown>>()
  const stream = sandbox.process.streamLogs(name, {
    onStdout: (line) => {
      try {
        const msg = JSON.parse(line) as Record<string, unknown>
        if (typeof msg.id === 'number') {
          seen.set(msg.id, msg)
          waiters.get(msg.id)?.(msg)
        }
      } catch {
        // not JSON, ignore
      }
    },
  })
  return {
    close: stream.close,
    reply(id: number, timeoutMs = 30000): Promise<Record<string, unknown>> {
      if (seen.has(id)) return Promise.resolve(seen.get(id)!)
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no JSON-RPC reply with id ${id}`)), timeoutMs)
        waiters.set(id, (msg) => { clearTimeout(t); resolve(msg) })
      })
    },
  }
}

// The dev gateway sometimes answers a process start with a 502 after ~10s
// even though the sandbox is healthy; that is unrelated to stdin, so retry.
async function execRetrying(sandbox: SandboxInstance, req: Parameters<SandboxInstance["process"]["exec"]>[0], attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await sandbox.process.exec(req)
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status
      if (status !== 502 || i >= attempts) throw e
    }
  }
}

async function waitForStatus(sandbox: SandboxInstance, name: string, wanted: string, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const p = await sandbox.process.get(name)
    if (p.status === wanted) return p
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`process ${name} did not reach ${wanted}`)
}

describe('Sandbox Process stdin', () => {
  let sandbox: SandboxInstance
  const sandboxName = uniqueName("process-stdin")

  beforeAll(async () => {
    sandbox = await SandboxInstance.create({
      name: sandboxName,
      image: defaultImage,
      region: defaultRegion,
      memory: 2048,
      labels: defaultLabels,
    })
  })

  afterAll(async () => {
    try {
      await SandboxInstance.delete(sandboxName)
    } catch {
      // Ignore
    }
  })

  it('drives a JSON-RPC echo loop over stdin and stops it with EOF', async () => {
    const name = "stdin-echo"
    const started = await execRetrying(sandbox, {
      name,
      stdin: true,
      command: `while IFS= read -r l; do id=$(printf '%s' "$l" | sed -n 's/.*"id":\\([0-9]*\\).*/\\1/p'); echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{\\"echo\\":$l}}"; done`,
    })
    expect(started.stdin).toBe(true)

    const reader = jsonRpcReader(sandbox, name)
    try {
      await sandbox.process.writeStdin(name, '{"jsonrpc":"2.0","id":1,"method":"ping"}\n')
      const reply = await reader.reply(1)
      const echo = (reply.result as { echo: { method: string } }).echo
      expect(echo.method).toBe("ping")

      // Order survives back-to-back writes.
      await sandbox.process.writeStdin(name, '{"jsonrpc":"2.0","id":2,"method":"a"}\n')
      await sandbox.process.writeStdin(name, '{"jsonrpc":"2.0","id":3,"method":"b"}\n')
      expect((await reader.reply(2)).id).toBe(2)
      expect((await reader.reply(3)).id).toBe(3)

      await sandbox.process.closeStdin(name)
      const done = await waitForStatus(sandbox, name, "completed")
      expect(done.exitCode).toBe(0)
    } finally {
      reader.close()
    }
  })

  it('refuses writes to a process started without stdin', async () => {
    const name = "no-stdin"
    await execRetrying(sandbox, { name, command: "sleep 10" })
    try {
      await expect(sandbox.process.writeStdin(name, "x\n")).rejects.toThrow(/409|stdin/)
    } finally {
      await sandbox.process.kill(name).catch(() => undefined)
    }
  })

  it('runs a real MCP stdio server: initialize, tools/list, shutdown on EOF', async () => {
    const name = "mcp-fs"
    await execRetrying(sandbox, {
      name,
      stdin: true,
      command: "npx -y @modelcontextprotocol/server-filesystem /tmp",
    })
    const reader = jsonRpcReader(sandbox, name)
    try {
      await sandbox.process.writeStdin(name, JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "sdk-integration", version: "0" } },
      }) + "\n")
      const init = await reader.reply(1, 120000) // first npx run downloads the package
      expect(init.error).toBeUndefined()
      expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBeTruthy()

      await sandbox.process.writeStdin(name, '{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
      await sandbox.process.writeStdin(name, '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n')
      const tools = (await reader.reply(2)).result as { tools: unknown[] }
      expect(tools.tools.length).toBeGreaterThan(0)

      await sandbox.process.closeStdin(name)
      const done = await sandbox.process.wait(name, { maxWait: 30000 })
      expect(done.status).not.toBe("running")
    } finally {
      reader.close()
      await sandbox.process.kill(name).catch(() => undefined)
    }
  })
})
