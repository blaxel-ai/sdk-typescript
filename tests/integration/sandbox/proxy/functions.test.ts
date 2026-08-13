import { SandboxInstance } from "@blaxel/core"
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName } from '../helpers.js'
import { createEchoServerSandbox, funcProxyHelperScript, lowercaseKeys, parseFullJsonOutput, proxyCleanup } from './helpers.js'

/**
 * Exercises the proxy's dynamic `{{FUNC:*}}` placeholders end to end:
 *  - the generated value reaches the upstream in the injected header/body, and
 *  - the same value is echoed back to the client on the response, keyed by the
 *    injection target: `X-Blaxel-Func-<target>: <funcname>=<value>[, …]`.
 *
 * Because at most 10 functions are expanded per request (across all headers and
 * body values combined), every non-budget route below stays comfortably under
 * that budget. Two dedicated routes probe the cap itself: one with exactly 10
 * functions (all resolve) and one with 11 (the excess breaks / stays literal).
 * Each route targets its own dedicated echo-server upstream so requests never
 * share a function set, which keeps the target-keyed echo assertions and the
 * budget tests unambiguous.
 */
describe('dynamic {{FUNC:*}} placeholder validation', () => {
  const createdSandboxes: string[] = []
  afterAll(proxyCleanup(createdSandboxes))

  let funcSandbox: Awaited<ReturnType<typeof SandboxInstance.create>>
  // One URL per route/upstream.
  let coreUrl: string
  let corePostUrl: string
  let echoFmtUrl: string
  let aliasUrl: string
  let failSafeUrl: string
  let budgetOkUrl: string
  let budgetUrl: string

  const SECRET = "tok_live_abc123"
  // A secret whose *value* is itself placeholder syntax. It must be substituted
  // verbatim and never re-interpreted (functions run before secrets).
  const TRICKY_SECRET = "{{FUNC:uuid()}}"

  // Exactly the per-request budget (10) -> all resolve, nothing breaks.
  const budgetOkTargets = Array.from({ length: 10 }, (_, i) => `X-K${String(i).padStart(2, "0")}`)
  const budgetOkHeaders = Object.fromEntries(budgetOkTargets.map((t) => [t, "{{FUNC:uuid()}}"]))
  // 11 single-function headers -> one over the per-request budget of 10.
  const budgetTargets = Array.from({ length: 11 }, (_, i) => `X-B${String(i).padStart(2, "0")}`)
  const budgetHeaders = Object.fromEntries(budgetTargets.map((t) => [t, "{{FUNC:uuid()}}"]))

  beforeAll(async () => {
    // One upstream per route so no two routes ever share a request.
    const [core, echoFmt, alias, failSafe, budgetOk, budget] = await Promise.all([
      createEchoServerSandbox(createdSandboxes),
      createEchoServerSandbox(createdSandboxes),
      createEchoServerSandbox(createdSandboxes),
      createEchoServerSandbox(createdSandboxes),
      createEchoServerSandbox(createdSandboxes),
      createEchoServerSandbox(createdSandboxes),
    ])
    coreUrl = `${core.url}/headers`
    corePostUrl = `${core.url}/post`
    echoFmtUrl = `${echoFmt.url}/headers`
    aliasUrl = `${alias.url}/headers`
    failSafeUrl = `${failSafe.url}/headers`
    budgetOkUrl = `${budgetOk.url}/headers`
    budgetUrl = `${budget.url}/headers`

    const name = uniqueName("proxy-func")
    funcSandbox = await SandboxInstance.create({
      name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
      network: {
        proxy: {
          routing: [
            {
              // ---- Core route: happy path, caps, trust boundary (8 funcs). --
              destinations: [core.host],
              headers: {
                "X-Uuid": "{{FUNC:uuid()}}",
                "X-Ts": "{{FUNC:timestamp()}}",
                "X-Hex": "{{FUNC:randhex(16)}}",
                "X-Nonce": "{{FUNC:nonce()}}",
                // Case-insensitive function name; surrounding literal preserved.
                "X-Case": "req-{{FUNC:UUIDV7()}}",
                // Length argument at the 1024 cap: allowed.
                "X-Hex-Cap": "{{FUNC:randhex(1024)}}",
                "X-Str-Cap": "{{FUNC:randstr(1024)}}",
                // Secret only (trust boundary + never echoed).
                "X-Token": `Bearer {{SECRET:api-token}}`,
              },
              body: { "event_time": "{{FUNC:timestamp_ms()}}" },
              secrets: { "api-token": SECRET },
            },
            {
              // ---- Echo-format route: token format & multiplicity (7 funcs).-
              destinations: [echoFmt.host],
              headers: {
                // Same function twice in one target -> two tokens, in order.
                "X-Pair": "{{FUNC:randstr(8)}}-{{FUNC:randstr(8)}}",
                // Two different functions in one target -> two named tokens.
                "X-Two-Kinds": "{{FUNC:uuid()}}|{{FUNC:timestamp()}}",
                // Function + resolvable secret: only the function token echoed.
                "X-Func-And-Secret": "{{FUNC:datetime()}}::{{SECRET:api-token}}",
                // Default lengths.
                "X-Hex-Default": "{{FUNC:randhex()}}",
                "X-Str-Default": "{{FUNC:randstr()}}",
              },
              secrets: { "api-token": SECRET },
            },
            {
              // ---- Alias/format route: aliases, time formats, randint (7). --
              destinations: [alias.host],
              headers: {
                "X-Uuidv4": "{{FUNC:uuidv4()}}",
                "X-Iso": "{{FUNC:iso8601()}}",
                "X-Date": "{{FUNC:date()}}",
                "X-Time": "{{FUNC:time()}}",
                "X-Ts-Ns": "{{FUNC:timestamp_ns()}}",
                "X-Randint": "{{FUNC:randint()}}",
                "X-Randint-N": "{{FUNC:randint(10)}}",
              },
            },
            {
              // ---- Fail-safe route: literals + resolution order + skip. ------
              // Only one function here (nonce, in the skipped injection), so the
              // uncertain budget-accounting of literals can never affect it.
              destinations: [failSafe.host],
              headers: {
                "X-Unknown": "{{FUNC:notafunction()}}",
                "X-Malformed": "{{FUNC:uuid}}",
                "X-No-Parens": "{{FUNC:randhex}}",
                "X-Over-Cap-Hex": "{{FUNC:randhex(1025)}}",
                "X-Over-Cap-Str": "{{FUNC:randstr(5000)}}",
                "X-Bad-Hex-Arg": "{{FUNC:randhex(abc)}}",
                "X-Bad-Int-Zero": "{{FUNC:randint(0)}}",
                // Secret value is placeholder syntax: substituted verbatim.
                "X-Tricky-Secret": "{{SECRET:tricky}}",
                // Function + failing secret -> whole injection skipped, nothing
                // echoed for its target.
                "X-Skip": "{{FUNC:nonce()}}-{{SECRET:missing}}",
              },
              secrets: { "tricky": TRICKY_SECRET },
            },
            {
              // ---- Budget boundary route: exactly 10 -> all resolve. --------
              destinations: [budgetOk.host],
              headers: budgetOkHeaders,
            },
            {
              // ---- Budget route: 11 functions -> exactly one over the cap. --
              destinations: [budget.host],
              headers: budgetHeaders,
            },
          ],
        },
      },
    })
    createdSandboxes.push(name)
    await funcSandbox.fs.write("/tmp/func-proxy-test.js", funcProxyHelperScript)
  }, 300_000)

  type FuncResult = {
    status: number
    responseHeaders: Record<string, string>
    upstream: { headers: Record<string, string>; json: Record<string, unknown> }
  }
  type EchoToken = { name: string; value: string }

  const runGet = async (url: string, extraHeaders?: string): Promise<FuncResult> => {
    const cmd = `node /tmp/func-proxy-test.js GET ${url}` + (extraHeaders ? ` '${extraHeaders}'` : "")
    const result = await funcSandbox.process.exec({ command: cmd, waitForCompletion: true })
    expect(result.exitCode).toBe(0)
    return parseFullJsonOutput<FuncResult>(result.logs)
  }

  // Parses the `X-Blaxel-Func-<target>` echo header into `name=value` tokens.
  // Generated values are hex / alphanumerics / digits / UUIDs / RFC 3339, none
  // of which contain `,` or `=`, so the split is unambiguous.
  const echoTokens = (res: FuncResult, target: string): EchoToken[] | undefined => {
    const raw = res.responseHeaders[`x-blaxel-func-${target.toLowerCase()}`]
    if (raw === undefined) return undefined
    return raw.split(",").map((t) => t.trim()).map((tok) => {
      const i = tok.indexOf("=")
      return { name: tok.slice(0, i), value: tok.slice(i + 1) }
    })
  }

  // ---------------------------------------------------------------------------
  // Core route: happy path, caps, trust boundary.
  // ---------------------------------------------------------------------------

  it('injects {{FUNC:uuid()}} and echoes it keyed by the target header', async () => {
    const res = await runGet(coreUrl)
    const injected = lowercaseKeys(res.upstream.headers)["x-uuid"]
    expect(injected).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    // New echo format: X-Blaxel-Func-X-Uuid: uuid=<value>
    expect(echoTokens(res, "X-Uuid")).toEqual([{ name: "uuid", value: injected }])
  }, 60_000)

  it('generates a fresh value on every request', async () => {
    const first = await runGet(coreUrl)
    const second = await runGet(coreUrl)
    expect(echoTokens(first, "X-Uuid")![0].value).not.toBe(echoTokens(second, "X-Uuid")![0].value)
  }, 60_000)

  it('injects {{FUNC:timestamp()}} as unix seconds and echoes it back', async () => {
    const res = await runGet(coreUrl)
    const injected = lowercaseKeys(res.upstream.headers)["x-ts"]
    expect(injected).toMatch(/^\d+$/)
    expect(echoTokens(res, "X-Ts")).toEqual([{ name: "timestamp", value: injected }])
    expect(Math.abs(Number(injected) - Math.floor(Date.now() / 1000))).toBeLessThan(300)
  }, 60_000)

  it('injects {{FUNC:randhex(16)}} and {{FUNC:nonce()}} with the right shapes', async () => {
    const res = await runGet(coreUrl)
    const h = lowercaseKeys(res.upstream.headers)
    expect(h["x-hex"]).toMatch(/^[0-9a-f]{16}$/)
    expect(echoTokens(res, "X-Hex")).toEqual([{ name: "randhex", value: h["x-hex"] }])
    expect(h["x-nonce"]).toMatch(/^[0-9a-f]{32}$/)
    expect(echoTokens(res, "X-Nonce")).toEqual([{ name: "nonce", value: h["x-nonce"] }])
  }, 60_000)

  it('resolves function names case-insensitively and echoes only the generated value', async () => {
    const res = await runGet(coreUrl)
    const injected = lowercaseKeys(res.upstream.headers)["x-case"]
    // {{FUNC:UUIDV7()}} resolved despite the uppercase name.
    expect(injected).toMatch(/^req-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    // The echo carries only the generated value, not the surrounding "req-".
    expect(echoTokens(res, "X-Case")).toEqual([{ name: "uuidv7", value: injected.slice("req-".length) }])
  }, 60_000)

  it('allows the maximum length argument (1024) for randhex/randstr', async () => {
    const res = await runGet(coreUrl)
    const h = lowercaseKeys(res.upstream.headers)
    expect(h["x-hex-cap"]).toMatch(/^[0-9a-f]{1024}$/)
    expect(h["x-str-cap"]).toMatch(/^[a-zA-Z0-9]{1024}$/)
  }, 60_000)

  it('injects {{FUNC:*}} into POST body fields and echoes keyed by the field name', async () => {
    const result = await funcSandbox.process.exec({
      command: `node /tmp/func-proxy-test.js POST ${corePostUrl} '{}' '{"user_field":"untouched","client_func":"{{FUNC:uuid()}}"}'`,
      waitForCompletion: true,
    })
    expect(result.exitCode).toBe(0)
    const res = parseFullJsonOutput<FuncResult>(result.logs)

    const injected = String(res.upstream.json.event_time)
    expect(injected).toMatch(/^\d+$/)
    expect(echoTokens(res, "event_time")).toEqual([{ name: "timestamp_ms", value: injected }])
    // Client-supplied fields are untouched; client {{FUNC:*}} stays literal.
    expect(res.upstream.json.user_field).toBe("untouched")
    expect(res.upstream.json.client_func).toBe("{{FUNC:uuid()}}")
  }, 60_000)

  it('resolves the secret on the wire but never exposes raw templates or the secret', async () => {
    const res = await runGet(coreUrl)
    const h = lowercaseKeys(res.upstream.headers)
    expect(h["x-token"]).toBe(`Bearer ${SECRET}`)
    expect(h["x-uuid"]).not.toContain("{{FUNC:")
    expect(h["x-token"]).not.toContain("{{SECRET:")
    // Secret-only target is never echoed, and the secret never appears anywhere.
    expect(echoTokens(res, "X-Token")).toBeUndefined()
    expect(JSON.stringify(res.responseHeaders)).not.toContain(SECRET)
  }, 60_000)

  it('does not expand {{FUNC:*}} in client-supplied request headers (and never echoes them)', async () => {
    const res = await runGet(coreUrl, '{"X-User-Func":"{{FUNC:uuid()}}"}')
    expect(lowercaseKeys(res.upstream.headers)["x-user-func"]).toBe("{{FUNC:uuid()}}")
    expect(echoTokens(res, "X-User-Func")).toBeUndefined()
  }, 60_000)

  // ---------------------------------------------------------------------------
  // Echo-format route: token format, multiplicity, func+secret.
  // ---------------------------------------------------------------------------

  it('emits one token per function occurrence, in generation order', async () => {
    const res = await runGet(echoFmtUrl)
    const injected = lowercaseKeys(res.upstream.headers)["x-pair"]
    const [a, b] = injected.split("-")
    expect(a).toMatch(/^[a-zA-Z0-9]{8}$/)
    expect(b).toMatch(/^[a-zA-Z0-9]{8}$/)
    expect(a).not.toBe(b)
    // Two randstr tokens under the single target header, in generation order.
    expect(echoTokens(res, "X-Pair")).toEqual([
      { name: "randstr", value: a },
      { name: "randstr", value: b },
    ])
  }, 60_000)

  it('names each token by its own function when a target mixes functions', async () => {
    const res = await runGet(echoFmtUrl)
    const injected = lowercaseKeys(res.upstream.headers)["x-two-kinds"]
    const [u, t] = injected.split("|")
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(t).toMatch(/^\d+$/)
    expect(echoTokens(res, "X-Two-Kinds")).toEqual([
      { name: "uuid", value: u },
      { name: "timestamp", value: t },
    ])
  }, 60_000)

  it('echoes only the function token when a target mixes a function and a secret', async () => {
    const res = await runGet(echoFmtUrl)
    const injected = lowercaseKeys(res.upstream.headers)["x-func-and-secret"]
    const [funcPart, secretPart] = injected.split("::")
    // Function expanded to an RFC 3339 timestamp; secret substituted after.
    expect(funcPart).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(secretPart).toBe(SECRET)
    // Only the datetime function token is echoed; the secret is never present.
    expect(echoTokens(res, "X-Func-And-Secret")).toEqual([{ name: "datetime", value: funcPart }])
    expect(JSON.stringify(res.responseHeaders)).not.toContain(SECRET)
  }, 60_000)

  it('applies the default lengths for randhex() and randstr()', async () => {
    const res = await runGet(echoFmtUrl)
    const h = lowercaseKeys(res.upstream.headers)
    expect(h["x-hex-default"]).toMatch(/^[0-9a-f]{32}$/)
    expect(h["x-str-default"]).toMatch(/^[a-zA-Z0-9]{16}$/)
  }, 60_000)

  // ---------------------------------------------------------------------------
  // Alias / format route: aliases, time formats, randint ranges.
  // ---------------------------------------------------------------------------

  it('resolves the uuidv4() and iso8601() aliases', async () => {
    const res = await runGet(aliasUrl)
    const h = lowercaseKeys(res.upstream.headers)
    expect(h["x-uuidv4"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(echoTokens(res, "X-Uuidv4")).toEqual([{ name: "uuidv4", value: h["x-uuidv4"] }])
    expect(h["x-iso"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(echoTokens(res, "X-Iso")).toEqual([{ name: "iso8601", value: h["x-iso"] }])
  }, 60_000)

  it('resolves date() and time() in the documented formats', async () => {
    const res = await runGet(aliasUrl)
    const h = lowercaseKeys(res.upstream.headers)
    expect(h["x-date"]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(echoTokens(res, "X-Date")).toEqual([{ name: "date", value: h["x-date"] }])
    expect(h["x-time"]).toMatch(/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/)
    expect(echoTokens(res, "X-Time")).toEqual([{ name: "time", value: h["x-time"] }])
  }, 60_000)

  it('resolves timestamp_ns() to a nanosecond integer', async () => {
    const res = await runGet(aliasUrl)
    const injected = lowercaseKeys(res.upstream.headers)["x-ts-ns"]
    expect(injected).toMatch(/^\d+$/)
    // Nanoseconds since epoch is ~19 digits (much wider than seconds/millis).
    expect(injected.length).toBeGreaterThanOrEqual(18)
    expect(echoTokens(res, "X-Ts-Ns")).toEqual([{ name: "timestamp_ns", value: injected }])
  }, 60_000)

  it('resolves randint() and randint(n) within their documented ranges', async () => {
    const res = await runGet(aliasUrl)
    const h = lowercaseKeys(res.upstream.headers)
    expect(h["x-randint"]).toMatch(/^\d+$/)
    const full = Number(h["x-randint"])
    expect(full).toBeGreaterThanOrEqual(0)
    expect(full).toBeLessThan(2147483647)
    expect(h["x-randint-n"]).toMatch(/^\d+$/)
    const bounded = Number(h["x-randint-n"])
    expect(bounded).toBeGreaterThanOrEqual(0)
    expect(bounded).toBeLessThan(10)
  }, 60_000)

  // ---------------------------------------------------------------------------
  // Fail-safe route: literals, resolution order, skip semantics.
  // ---------------------------------------------------------------------------

  it('leaves unknown, malformed, invalid-arg and over-cap placeholders literal (no echo)', async () => {
    const res = await runGet(failSafeUrl)
    const h = lowercaseKeys(res.upstream.headers)
    expect(h["x-unknown"]).toBe("{{FUNC:notafunction()}}")
    expect(h["x-malformed"]).toBe("{{FUNC:uuid}}")
    expect(h["x-no-parens"]).toBe("{{FUNC:randhex}}")
    expect(h["x-over-cap-hex"]).toBe("{{FUNC:randhex(1025)}}")
    expect(h["x-over-cap-str"]).toBe("{{FUNC:randstr(5000)}}")
    expect(h["x-bad-hex-arg"]).toBe("{{FUNC:randhex(abc)}}")
    expect(h["x-bad-int-zero"]).toBe("{{FUNC:randint(0)}}")
    // Nothing resolved -> no echo headers for any of these targets.
    for (const t of ["X-Unknown", "X-Malformed", "X-No-Parens", "X-Over-Cap-Hex", "X-Bad-Hex-Arg"]) {
      expect(echoTokens(res, t)).toBeUndefined()
    }
  }, 60_000)

  it('substitutes a secret whose value is placeholder syntax verbatim (never re-interpreted)', async () => {
    const res = await runGet(failSafeUrl)
    // The secret value "{{FUNC:uuid()}}" is inserted after the function pass has
    // already run, so it is never expanded into a UUID.
    expect(lowercaseKeys(res.upstream.headers)["x-tricky-secret"]).toBe(TRICKY_SECRET)
    expect(echoTokens(res, "X-Tricky-Secret")).toBeUndefined()
  }, 60_000)

  it('skips an injection whose secret fails to resolve, echoing nothing for its target', async () => {
    const res = await runGet(failSafeUrl)
    // The whole "X-Skip" injection is dropped: no header reaches the upstream...
    expect(lowercaseKeys(res.upstream.headers)["x-skip"]).toBeUndefined()
    // ...and its function is not echoed, so the response never claims otherwise.
    expect(echoTokens(res, "X-Skip")).toBeUndefined()
  }, 60_000)

  // ---------------------------------------------------------------------------
  // Budget route: per-request function cap.
  // ---------------------------------------------------------------------------

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

  it('expands exactly 10 functions in a request with none left literal (budget boundary)', async () => {
    const res = await runGet(budgetOkUrl)
    const h = lowercaseKeys(res.upstream.headers)
    // At the cap: every one of the 10 functions resolves, nothing is literal.
    const resolved = budgetOkTargets.filter((t) => uuidRe.test(h[t.toLowerCase()] ?? ""))
    const literal = budgetOkTargets.filter((t) => (h[t.toLowerCase()] ?? "").includes("{{FUNC:"))
    expect(resolved).toHaveLength(10)
    expect(literal).toHaveLength(0)
    const echoCount = Object.keys(res.responseHeaders)
      .filter((k) => /^x-blaxel-func-x-k\d+$/.test(k)).length
    expect(echoCount).toBe(10)
  }, 60_000)

  it('breaks the 11th function: at most 10 expand per request, the excess stays literal', async () => {
    const res = await runGet(budgetUrl)
    const h = lowercaseKeys(res.upstream.headers)

    const resolved = budgetTargets.filter((t) => uuidRe.test(h[t.toLowerCase()] ?? ""))
    const literal = budgetTargets.filter((t) => h[t.toLowerCase()] === "{{FUNC:uuid()}}")
    // 11 requested: exactly 10 expand and exactly 1 is left literal (which one is
    // non-deterministic, but the counts are not). Contrast with the 10-function
    // boundary test above, which resolves all 10 -- pinning the cutoff at 10->11.
    expect(resolved).toHaveLength(10)
    expect(literal).toHaveLength(1)

    // Exactly one echo header per expanded target (the broken one is not echoed).
    const echoCount = Object.keys(res.responseHeaders)
      .filter((k) => /^x-blaxel-func-x-b\d+$/.test(k)).length
    expect(echoCount).toBe(10)
  }, 60_000)
})
