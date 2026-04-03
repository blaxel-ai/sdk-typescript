import { SandboxInstance } from "@blaxel/core"
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName } from '../helpers.js'
import { proxyCleanup } from './helpers.js'

describe('proxy e2e with Claude Code agent', () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    it.skip('requires ANTHROPIC_API_KEY', () => {})
    return
  }

  const createdSandboxes: string[] = []
  afterAll(proxyCleanup(createdSandboxes))

  let claudeSandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

  beforeAll(async () => {
    const name = uniqueName("proxy-claude")
    claudeSandbox = await SandboxInstance.create({
      name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
      envs: [{ name: "ANTHROPIC_API_KEY", value: process.env.ANTHROPIC_API_KEY! }],
      network: {
        proxy: { routing: [{ destinations: ["httpbin.org"], headers: { "X-Agent-Test": "claude-injected" } }] },
      },
    })
    createdSandboxes.push(name)

    const setup = await claudeSandbox.process.exec({ command: 'apk add --no-cache curl bash 2>&1 && npm install -g @anthropic-ai/claude-code 2>&1 && adduser -D -s /bin/bash agent 2>&1', waitForCompletion: true })
    if (setup.exitCode !== 0) throw new Error(`setup failed: ${setup.logs?.slice(0, 500)}`)
  }, 300_000)

  const claudeEnv = [
    'export PATH=/usr/local/bin:/usr/bin:/bin',
    'ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY',
    'HTTP_PROXY=$HTTP_PROXY', 'HTTPS_PROXY=$HTTPS_PROXY', 'NO_PROXY=$NO_PROXY',
    'NODE_EXTRA_CA_CERTS=$NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE=$SSL_CERT_FILE',
  ].join(' ')

  it('agent reaches Anthropic API through the proxy', async () => {
    const result = await claudeSandbox.process.exec({
      command: `su - agent -c "${claudeEnv} && claude --dangerously-skip-permissions -p \\"What is 2+2? Reply with ONLY the number.\\" --output-format text" 2>&1`,
      waitForCompletion: true,
    })
    expect(result.exitCode).toBe(0)
    expect(result.logs).toContain("4")
  }, 120_000)

  it('agent makes outbound call through the proxy with header injection', async () => {
    const result = await claudeSandbox.process.exec({
      command: `su - agent -c "${claudeEnv} && claude --dangerously-skip-permissions -p \\"Run: curl -s https://httpbin.org/headers — then print the full JSON output.\\" --output-format text" 2>&1`,
      waitForCompletion: true,
    })
    expect(result.exitCode).toBe(0)
    expect(result.logs).toContain("X-Agent-Test")
    expect(result.logs).toContain("claude-injected")
  }, 180_000)
})
