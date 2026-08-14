import { SandboxInstance } from "@blaxel/core"
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName } from '../helpers.js'
import { createEchoServerSandbox, createReadyProxySandbox, funcProxyHelperScript, parseFullJsonOutput, proxyCleanup } from './helpers.js'

/**
 * Conformance tests for the egress pattern grammar packed into the
 * `allowedDomains` / `forbiddenDomains` string arrays: `METHOD:...:host/path`
 * with an optional leading `!` negation.
 *
 * Two block signals exist and are handled distinctly:
 *  - Host-level denial (a host that fails the allow/forbid host check) is
 *    enforced at CONNECT time, so the tunneled request fails (non-zero exit).
 *  - Method/path denial happens after the proxy inspects the decrypted request,
 *    so the host connects fine and the proxy answers with HTTP 403
 *    (`Proxy-Error: firewall_blocked`). We read the response status to detect it.
 *
 * Every scenario asserts both the allow and the intended break. Checks retry to
 * absorb firewall-config propagation lag.
 */
describe('egress pattern grammar (allowedDomains / forbiddenDomains)', () => {
  const createdSandboxes: string[] = []
  afterAll(proxyCleanup(createdSandboxes))

  // One controlled upstream shared by every route; H is its hostname.
  let echoHost: string
  let echoUrl: string

  let methodSandbox: Awaited<ReturnType<typeof SandboxInstance.create>>
  let pathSandbox: Awaited<ReturnType<typeof SandboxInstance.create>>
  let forbidSandbox: Awaited<ReturnType<typeof SandboxInstance.create>>
  let bangSandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

  async function mkSandbox(
    prefix: string,
    network: Record<string, unknown>,
    probe: string,
  ): Promise<Awaited<ReturnType<typeof SandboxInstance.create>>> {
    const sandbox = await createReadyProxySandbox(
      async () => {
        const name = uniqueName(prefix)
        const s = await SandboxInstance.create({
          name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
          network: { ...network, proxy: { routing: [] } },
        })
        return { name, sandbox: s }
      },
      createdSandboxes,
      `node /tmp/proxy-test.js GET ${echoUrl}${probe}`,
    )
    await sandbox.fs.write("/tmp/fw-test.js", funcProxyHelperScript)
    return sandbox
  }

  beforeAll(async () => {
    const echo = await createEchoServerSandbox(createdSandboxes)
    echoHost = echo.host
    echoUrl = echo.url

    ;[methodSandbox, pathSandbox, forbidSandbox, bangSandbox] = await Promise.all([
      mkSandbox("fw-method", {
        allowedDomains: [
          `GET:POST:${echoHost}/m-*`,   // method-restricted path
          `!POST:${echoHost}/n-*`,      // negated method set
          `get:${echoHost}/c-*`,        // lower-case verb token
        ],
      }, "/m-ok"),
      mkSandbox("fw-path", {
        allowedDomains: [
          `${echoHost}/prefix/`,        // start-anchored prefix, trailing slash
          `${echoHost}/mercor*`,        // glob prefix
        ],
      }, "/mercor-1"),
      mkSandbox("fw-forbid", {
        allowedDomains: [`${echoHost}`],           // allow the whole host...
        forbiddenDomains: [
          `POST:${echoHost}/f-*`,       // ...but forbid POST under /f-*
          `${echoHost}/secret*`,        // ...and everything under /secret*
        ],
      }, "/anything"),
      mkSandbox("fw-bang", {
        allowedDomains: [`!${echoHost}`],          // lone `!` is a no-op -> host H
      }, "/x"),
    ])
  }, 300_000)

  // --- egress probe -------------------------------------------------------
  type Egress = { allowed: boolean; via: 'connect' | 'response'; status?: number }

  const target = (t: string) => (t.startsWith("http") ? t : `${echoUrl}${t}`)

  async function probe(
    sandbox: Awaited<ReturnType<typeof SandboxInstance.create>>,
    method: string,
    t: string,
  ): Promise<Egress> {
    const res = await sandbox.process.exec({
      command: `node /tmp/fw-test.js ${method} ${target(t)}`,
      waitForCompletion: true,
    })
    // Host-level denial (or a hard network failure) surfaces as a non-zero exit.
    if (res.exitCode !== 0) return { allowed: false, via: 'connect' }
    let out: { status?: number }
    try {
      out = parseFullJsonOutput<{ status?: number }>(res.logs)
    } catch {
      return { allowed: false, via: 'connect' }
    }
    const status = typeof out.status === 'number' ? out.status : undefined
    return { allowed: status !== undefined && status >= 200 && status < 300, via: 'response', status }
  }

  // Retry until the outcome matches expectation (absorbs propagation lag).
  async function settle(fn: () => Promise<Egress>, want: boolean, retries = 5, delayMs = 2000): Promise<Egress> {
    let last = await fn()
    for (let i = 0; i < retries && last.allowed !== want; i++) {
      await new Promise((r) => setTimeout(r, delayMs))
      last = await fn()
    }
    return last
  }

  const allow = (s: Parameters<typeof probe>[0]) => async (method: string, t: string) => {
    const o = await settle(() => probe(s, method, t), true)
    expect(o.allowed, `expected ALLOW ${method} ${t} -> ${JSON.stringify(o)}`).toBe(true)
    return o
  }
  const block = (s: Parameters<typeof probe>[0]) => async (method: string, t: string) => {
    const o = await settle(() => probe(s, method, t), false)
    expect(o.allowed, `expected BLOCK ${method} ${t} -> ${JSON.stringify(o)}`).toBe(false)
    // Method/path denials are answered with a 403 after CONNECT succeeds.
    if (o.via === 'response') expect(o.status, JSON.stringify(o)).toBe(403)
    return o
  }

  // ---------------------------------------------------------------------------
  // Method matching and negation.
  // ---------------------------------------------------------------------------

  it('allows a method in the set and blocks one outside it', async () => {
    const A = { allow: allow(methodSandbox), block: block(methodSandbox) }
    await A.allow("GET", "/m-ok")     // GET is in GET:POST
    await A.allow("POST", "/m-ok")    // POST is in GET:POST
    await A.block("DELETE", "/m-ok")  // DELETE is not -> blocked
  }, 60_000)

  it('parses method tokens case-insensitively', async () => {
    // `get:` must be recognized as the GET verb, not kept as a literal host.
    await allow(methodSandbox)("GET", "/c-x")
  }, 60_000)

  it('negated method set allows everything except the listed method', async () => {
    await allow(methodSandbox)("GET", "/n-x")   // !POST allows GET
    await block(methodSandbox)("POST", "/n-x")  // !POST blocks POST
  }, 60_000)

  it('blocks a path that matches no allow pattern', async () => {
    await block(methodSandbox)("GET", "/unmatched")
  }, 60_000)

  // ---------------------------------------------------------------------------
  // Path globs and normalization.
  // ---------------------------------------------------------------------------

  it('treats a path pattern as a start-anchored prefix', async () => {
    await allow(pathSandbox)("GET", "/prefix/file.txt")  // under /prefix/
    await allow(pathSandbox)("GET", "/prefix/")          // the dir root itself
    await block(pathSandbox)("GET", "/prefix")           // no trailing slash -> no match
  }, 60_000)

  it('ignores the query string when matching a path', async () => {
    await allow(pathSandbox)("GET", "/prefix/x?sig=secret")
  }, 60_000)

  it('matches a glob prefix and blocks a sibling path', async () => {
    await allow(pathSandbox)("GET", "/mercor-1/obj")
    await block(pathSandbox)("GET", "/other/obj")
  }, 60_000)

  it('canonicalizes duplicate slashes before matching', async () => {
    await allow(pathSandbox)("GET", "//mercor//obj")  // -> /mercor/obj, matches /mercor*
  }, 60_000)

  it('blocks a path traversal that escapes the allowed prefix', async () => {
    // /mercor/../other/obj normalizes to /other/obj, which matches nothing.
    await block(pathSandbox)("GET", "/mercor/../other/obj")
  }, 60_000)

  // ---------------------------------------------------------------------------
  // Forbidden precedence (forbidden always wins over allow).
  // ---------------------------------------------------------------------------

  it('allows a request that matches allow and no forbid rule', async () => {
    await allow(forbidSandbox)("GET", "/anything")
  }, 60_000)

  it('lets a forbidden rule override the host allow (method-scoped)', async () => {
    await block(forbidSandbox)("POST", "/f-x")  // POST:/f-* forbidden -> blocked
    await allow(forbidSandbox)("GET", "/f-x")   // GET not forbidden -> allowed through
  }, 60_000)

  it('blocks a forbidden path even though the host is allowed', async () => {
    await block(forbidSandbox)("GET", "/secret/key")
  }, 60_000)

  it('blocks a traversal that lands inside a forbidden prefix', async () => {
    // /public/../secret/key normalizes to /secret/key -> forbidden.
    await block(forbidSandbox)("GET", "/public/../secret/key")
  }, 60_000)

  it('strips the query string before evaluating a forbidden path', async () => {
    await block(forbidSandbox)("GET", "/secret/x?sig=z")
  }, 60_000)

  // ---------------------------------------------------------------------------
  // Host-grammar edge: a lone `!` (no method) degrades to the plain host.
  // ---------------------------------------------------------------------------

  it('treats `!host` (no method) as the plain host, keeping the allowlist active', async () => {
    await allow(bangSandbox)("GET", "/x")                     // H is allowed
    await block(bangSandbox)("GET", "https://example.com")    // a non-listed host is not
  }, 60_000)
})
