import { SandboxInstance } from "@blaxel/core"
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName } from '../helpers.js'
import { lowercaseKeys, parseJsonOutput, proxyCleanup, proxyHelperScript } from './helpers.js'

describe('proxy vs no-proxy comparison', () => {
  const createdSandboxes: string[] = []
  afterAll(proxyCleanup(createdSandboxes))

  let proxySandbox: Awaited<ReturnType<typeof SandboxInstance.create>>
  let noProxySandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

  async function timedExec(
    sb: Awaited<ReturnType<typeof SandboxInstance.create>>,
    command: string,
  ): Promise<{ logs: string | undefined; exitCode: number | undefined; durationMs: number }> {
    const start = Date.now()
    const result = await sb.process.exec({ command, waitForCompletion: true })
    return { logs: result.logs, exitCode: result.exitCode, durationMs: Date.now() - start }
  }

  beforeAll(async () => {
    const [proxyName, noProxyName] = [uniqueName("cmp-proxy"), uniqueName("cmp-noproxy")]
    const [pSb, npSb] = await Promise.all([
      SandboxInstance.create({
        name: proxyName, image: defaultImage, region: defaultRegion, labels: defaultLabels,
        network: {
          proxy: { routing: [{ destinations: ["httpbin.org"], headers: { "X-Proxy-Compare": "with-proxy", "X-Api-Key": "{{SECRET:cmp-key}}" }, body: { "injected_field": "proxy-injected" }, secrets: { "cmp-key": "comparison-secret-123" } }] },
        },
      }),
      SandboxInstance.create({ name: noProxyName, image: defaultImage, region: defaultRegion, labels: defaultLabels }),
    ])
    proxySandbox = pSb
    noProxySandbox = npSb
    createdSandboxes.push(proxyName, noProxyName)
    await Promise.all([
      proxySandbox.fs.write("/tmp/proxy-test.js", proxyHelperScript),
      noProxySandbox.fs.write("/tmp/proxy-test.js", proxyHelperScript),
    ])

    for (let i = 0; i < 10; i++) {
      const warmup = await proxySandbox.process.exec({
        command: 'node /tmp/proxy-test.js GET https://httpbin.org/headers',
        waitForCompletion: true,
      })
      if (warmup.exitCode === 0) {
        try {
          const h = lowercaseKeys(parseJsonOutput(warmup.logs).headers)
          if (h["x-proxy-compare"]) break
        } catch {}
      }
      await new Promise(r => setTimeout(r, 2000))
    }
  }, 180_000)

  it('proxy sandbox injects headers, no-proxy sandbox does not', async () => {
    const [proxyResult, noProxyResult] = await Promise.all([
      timedExec(proxySandbox, 'node /tmp/proxy-test.js GET https://httpbin.org/headers'),
      timedExec(noProxySandbox, 'node /tmp/proxy-test.js GET https://httpbin.org/headers'),
    ])
    expect(proxyResult.exitCode).toBe(0)
    expect(noProxyResult.exitCode).toBe(0)
    const proxyHeaders = lowercaseKeys(parseJsonOutput(proxyResult.logs).headers)
    const noProxyHeaders = lowercaseKeys(parseJsonOutput(noProxyResult.logs).headers)
    expect(proxyHeaders["x-proxy-compare"]).toBe("with-proxy")
    expect(proxyHeaders["x-api-key"]).toBe("comparison-secret-123")
    expect(proxyHeaders["x-blaxel-request-id"]).toBeDefined()
    expect(noProxyHeaders["x-proxy-compare"]).toBeUndefined()
    expect(noProxyHeaders["x-api-key"]).toBeUndefined()
    expect(noProxyHeaders["x-blaxel-request-id"]).toBeUndefined()
    console.log(`[compare GET headers] proxy: ${proxyResult.durationMs}ms, no-proxy: ${noProxyResult.durationMs}ms, overhead: ${proxyResult.durationMs - noProxyResult.durationMs}ms`)
  }, 60_000)

  it('proxy sandbox injects body fields, no-proxy sandbox does not', async () => {
    const postBody = JSON.stringify({ user_data: "original" })
    const cmd = `node /tmp/proxy-test.js POST https://httpbin.org/post '{}' '${postBody}'`
    const [proxyResult, noProxyResult] = await Promise.all([timedExec(proxySandbox, cmd), timedExec(noProxySandbox, cmd)])
    expect(proxyResult.exitCode).toBe(0)
    expect(noProxyResult.exitCode).toBe(0)
    expect(parseJsonOutput(proxyResult.logs).json.user_data).toBe("original")
    expect(parseJsonOutput(proxyResult.logs).json.injected_field).toBe("proxy-injected")
    expect(parseJsonOutput(noProxyResult.logs).json.user_data).toBe("original")
    expect(parseJsonOutput(noProxyResult.logs).json.injected_field).toBeUndefined()
    console.log(`[compare POST body] proxy: ${proxyResult.durationMs}ms, no-proxy: ${noProxyResult.durationMs}ms, overhead: ${proxyResult.durationMs - noProxyResult.durationMs}ms`)
  }, 60_000)

  it('proxy sandbox has proxy env vars, no-proxy sandbox does not', async () => {
    const envCmd = `node -e 'const vars = ["HTTP_PROXY","HTTPS_PROXY","NO_PROXY","NODE_EXTRA_CA_CERTS","SSL_CERT_FILE"]; const r = {}; vars.forEach(v => r[v] = process.env[v] ? "set" : "unset"); console.log(JSON.stringify(r));'`
    const [proxyEnv, noProxyEnv] = await Promise.all([
      proxySandbox.process.exec({ command: envCmd, waitForCompletion: true }),
      noProxySandbox.process.exec({ command: envCmd, waitForCompletion: true }),
    ])
    expect(proxyEnv.exitCode).toBe(0)
    expect(noProxyEnv.exitCode).toBe(0)
    const pEnvs = parseJsonOutput(proxyEnv.logs)
    const npEnvs = parseJsonOutput(noProxyEnv.logs)
    expect(pEnvs["HTTP_PROXY"]).toBe("set")
    expect(pEnvs["HTTPS_PROXY"]).toBe("set")
    expect(pEnvs["NODE_EXTRA_CA_CERTS"]).toBe("set")
    expect(npEnvs["HTTP_PROXY"]).toBe("unset")
    expect(npEnvs["HTTPS_PROXY"]).toBe("unset")
    expect(npEnvs["NODE_EXTRA_CA_CERTS"]).toBe("unset")
  }, 60_000)

  it('both sandboxes reach the same endpoint successfully', async () => {
    const cmd = 'node /tmp/proxy-test.js GET https://httpbin.org/get'
    const [proxyResult, noProxyResult] = await Promise.all([timedExec(proxySandbox, cmd), timedExec(noProxySandbox, cmd)])
    expect(proxyResult.exitCode).toBe(0)
    expect(noProxyResult.exitCode).toBe(0)
    expect(parseJsonOutput(proxyResult.logs).url).toBe("https://httpbin.org/get")
    expect(parseJsonOutput(noProxyResult.logs).url).toBe("https://httpbin.org/get")
    console.log(`[compare GET /get] proxy: ${proxyResult.durationMs}ms, no-proxy: ${noProxyResult.durationMs}ms, overhead: ${proxyResult.durationMs - noProxyResult.durationMs}ms`)
  }, 60_000)

  it('latency overhead is within acceptable bounds', async () => {
    const iterations = 3
    const proxyTimes: number[] = []
    const noProxyTimes: number[] = []
    for (let i = 0; i < iterations; i++) {
      const [p, np] = await Promise.all([
        timedExec(proxySandbox, 'node /tmp/proxy-test.js GET https://httpbin.org/get'),
        timedExec(noProxySandbox, 'node /tmp/proxy-test.js GET https://httpbin.org/get'),
      ])
      expect(p.exitCode).toBe(0)
      expect(np.exitCode).toBe(0)
      proxyTimes.push(p.durationMs)
      noProxyTimes.push(np.durationMs)
    }
    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length
    const proxyAvg = avg(proxyTimes)
    const noProxyAvg = avg(noProxyTimes)
    const overheadMs = proxyAvg - noProxyAvg
    const overheadPct = noProxyAvg > 0 ? (overheadMs / noProxyAvg) * 100 : 0
    console.log(`[latency benchmark] proxy avg: ${proxyAvg.toFixed(0)}ms, no-proxy avg: ${noProxyAvg.toFixed(0)}ms`)
    console.log(`[latency benchmark] overhead: ${overheadMs.toFixed(0)}ms (${overheadPct.toFixed(1)}%)`)
    console.log(`[latency benchmark] proxy samples: [${proxyTimes.join(', ')}], no-proxy samples: [${noProxyTimes.join(', ')}]`)
    expect(overheadMs).toBeLessThan(5000)
  }, 180_000)
})
