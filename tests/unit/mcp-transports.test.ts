import { BlaxelMcpClientTransport, BlaxelMcpServerTransport } from "@blaxel/core"
import { Client as ClientV2 } from "@modelcontextprotocol/client"
import { Client as ClientV1 } from "@modelcontextprotocol/sdk/client/index.js"
import { McpServer as McpServerV1 } from "@modelcontextprotocol/sdk/server/mcp.js"
import { McpServer as McpServerV2 } from "@modelcontextprotocol/server"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"

// The Blaxel WebSocket transports must plug into both the MCP 1.x
// (@modelcontextprotocol/sdk) and 2.x (@modelcontextprotocol/server, /client) APIs.

const echoTool = {
  description: "Echo after a delay",
  inputSchema: z.object({ text: z.string(), delayMs: z.number() }),
}

async function echo({ text, delayMs }: { text: string; delayMs: number }) {
  await new Promise((r) => setTimeout(r, delayMs))
  return { content: [{ type: "text" as const, text }] }
}

// Resolves when the server-side abort signal fires, or after 2s.
function waitForAbort(signal: AbortSignal, onAbort: () => void) {
  return new Promise<{ content: [] }>((resolve) => {
    const done = () => resolve({ content: [] })
    signal.addEventListener("abort", () => { onAbort(); done() })
    setTimeout(done, 2000)
  })
}

function startServer(version: "v1" | "v2", port: number) {
  const transport = new BlaxelMcpServerTransport(port)
  const state = { aborted: false }
  const onAbort = () => { state.aborted = true }
  if (version === "v1") {
    const server = new McpServerV1({ name: "test", version: "1.0.0" })
    server.registerTool("echo", { description: echoTool.description, inputSchema: echoTool.inputSchema.shape }, echo)
    server.registerTool("wait", { description: "Wait for cancel" }, (extra) => waitForAbort(extra.signal, onAbort))
    return { state, connect: () => server.connect(transport), close: () => server.close() }
  }
  const server = new McpServerV2({ name: "test", version: "1.0.0" })
  server.registerTool("echo", echoTool, echo)
  server.registerTool("wait", { description: "Wait for cancel" }, (ctx) => waitForAbort(ctx.mcpReq.signal, onAbort))
  return { state, connect: () => server.connect(transport), close: () => server.close() }
}

async function connectClient(version: "v1" | "v2", port: number) {
  const transport = new BlaxelMcpClientTransport(`http://localhost:${port}`, {}, { retry: { max: 0 } })
  const client = version === "v1"
    ? new ClientV1({ name: "c", version: "1.0.0" })
    : new ClientV2({ name: "c", version: "1.0.0" })
  await client.connect(transport)
  return client
}

const textOf = (result: unknown) =>
  ((result as { content: { text: string }[] }).content[0]).text

let port = 18900
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => undefined)
})

const combos = [
  ["v1", "v1"],
  ["v2", "v2"],
  ["v1", "v2"],
  ["v2", "v1"],
] as const

describe.each(combos)("server %s with client %s", (serverVersion, clientVersion) => {
  it("lists and calls tools, and routes each reply to the client that asked", async () => {
    const p = port++
    const server = startServer(serverVersion, p)
    await server.connect()
    cleanups.push(server.close)

    const a = await connectClient(clientVersion, p)
    const b = await connectClient(clientVersion, p)
    cleanups.push(() => a.close(), () => b.close())

    const tools = await a.listTools()
    expect(tools.tools.map((t) => t.name)).toEqual(["echo", "wait"])

    // Interleave: a's call finishes after b's, so a wrong route would hand
    // a's reply to b (or both replies to one client).
    const [ra, rb] = await Promise.all([
      a.callTool({ name: "echo", arguments: { text: "from-a", delayMs: 150 } }),
      b.callTool({ name: "echo", arguments: { text: "from-b", delayMs: 10 } }),
    ])
    expect(textOf(ra)).toBe("from-a")
    expect(textOf(rb)).toBe("from-b")
  })

  it("forwards a client cancel to the running tool", async () => {
    const p = port++
    const server = startServer(serverVersion, p)
    await server.connect()
    cleanups.push(server.close)
    const client = await connectClient(clientVersion, p)
    cleanups.push(() => client.close())

    const controller = new AbortController()
    const params = { name: "wait", arguments: {} }
    const options = { signal: controller.signal }
    // v1 takes (params, resultSchema, options); v2 takes (params, options).
    const call = client instanceof ClientV1
      ? client.callTool(params, undefined, options)
      : client.callTool(params, options)
    setTimeout(() => controller.abort(), 100)
    await expect(call).rejects.toThrow()
    await expect.poll(() => server.state.aborted, { timeout: 1000 }).toBe(true)
  })
})
