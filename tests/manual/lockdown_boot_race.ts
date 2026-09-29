// Manual test: a lockdown ("proxy" firewall ruleset) sandbox must never have a
// window of open egress, and re-creating the same name right after a delete
// must not fail on the leftover pod.
//
// Exercises the controlplane change that registers the network-controller
// workload BEFORE the pod is created (and clears a leftover same-name pod
// first). Two things are checked, per iteration:
//
//   1. boot window: the very first exec after create is a DIRECT call (all
//      proxy env vars stripped) to an external host with a short timeout.
//      It must fail (exit 124 = packets dropped, or 1/6/7 = refused). Exit 0
//      is a LEAK: the guest could talk to the outside before lockdown landed.
//   2. steady state: the same call through the proxy must succeed (200),
//      retried while the proxy warms up.
//
// Each iteration deletes the sandbox and immediately re-creates the SAME
// name, so from the second one on the k8s pod is usually still Terminating:
// this is the 409 / leftover-pod path that used to bind the lockdown to the
// old pod. Every rejected API call is printed verbatim.
//
// Run (after `cd @blaxel/core && npm run build`):
//
//   BL_ENV=dev BL_WORKSPACE=… BL_API_KEY=… npx tsx tests/manual/lockdown_boot_race.ts
//
// Env vars:
//   NAME          sandbox name (default: lockdown-race-<random>)
//   IMAGE         sandbox image (default blaxel/base-image:latest)
//   REGION        region (default BL_REGION, or eu-dub-1 on dev / us-was-1 elsewhere)
//   ITERATIONS    create → probe → delete → re-create cycles (default 5)
//   TARGET        external URL for the probes (default https://example.com)
//   CONTROL       first run the direct probe in a sandbox WITHOUT lockdown, to
//                 prove the probe does reach the target (default "true")
//   CLEANUP       delete the sandbox at the end (default "true")
//
// The sandbox process API reports exit -1 / status "failed" for a process that
// `timeout` had to kill: for the direct probe that is the expected "packets
// dropped" outcome.

import { SandboxInstance } from "@blaxel/core"
import { v4 as uuidv4 } from "uuid"

const NAME = process.env.NAME || `lockdown-race-${uuidv4().replace(/-/g, "").substring(0, 8)}`
const IMAGE = process.env.IMAGE || "blaxel/base-image:latest"
const REGION = process.env.REGION || process.env.BL_REGION || (process.env.BL_ENV === "dev" ? "eu-dub-1" : "us-was-1")
const ITERATIONS = parseInt(process.env.ITERATIONS || "5", 10)
const TARGET = process.env.TARGET || "https://example.com"
const CLEANUP = (process.env.CLEANUP ?? "true") === "true"
const CONTROL = (process.env.CONTROL ?? "true") === "true"
const TARGET_HOST = new URL(TARGET).hostname

const NO_PROXY_ENV = "env -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY -u https_proxy -u NO_PROXY -u no_proxy"
// Plain node https.get: no proxy awareness, so with the env stripped it goes direct.
const DIRECT_PROBE = `timeout 5 ${NO_PROXY_ENV} node -e "require('https').get('${TARGET}',r=>{console.log(r.statusCode);process.exit(0)}).on('error',e=>{console.error(e.code||e.message);process.exit(1)})"`
// CONNECT through HTTPS_PROXY (node ignores the env var by itself), prints the upstream status.
const PROXY_PROBE_PATH = "/tmp/lockdown-probe.js"
const PROXY_PROBE_SCRIPT = `
const https = require("https"), tls = require("tls"), net = require("net");
const target = new URL(process.argv[2]);
const proxy = new URL(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);
const port = parseInt(proxy.port) || (proxy.protocol === "https:" ? 443 : 3128);
const auth = proxy.username ? "Proxy-Authorization: Basic " + Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password || "")).toString("base64") + "\\r\\n" : "";
setTimeout(() => { console.error("PROXY TIMEOUT"); process.exit(1) }, 10000);
const onSocket = (sock) => {
  let buf = "";
  sock.on("data", function h(c) {
    buf += c; if (!buf.includes("\\r\\n\\r\\n")) return; sock.removeListener("data", h);
    const code = parseInt(buf.split(" ")[1]);
    if (code !== 200) { console.error("CONNECT " + code); process.exit(1) }
    https.get({ host: target.hostname, path: target.pathname, socket: sock, agent: false, servername: target.hostname }, (r) => { console.log(r.statusCode); process.exit(0) })
      .on("error", (e) => { console.error(e.code || e.message); process.exit(1) });
  });
  sock.write("CONNECT " + target.hostname + ":443 HTTP/1.1\\r\\nHost: " + target.hostname + ":443\\r\\n" + auth + "\\r\\n");
};
const s = proxy.protocol === "https:" ? tls.connect({ host: proxy.hostname, port }, () => onSocket(s)) : net.connect({ host: proxy.hostname, port }, () => onSocket(s));
s.on("error", (e) => { console.error("PROXY " + (e.code || e.message)); process.exit(1) });
`.trim()
const PROXIED_PROBE = `node ${PROXY_PROBE_PATH} ${TARGET}`

type Iteration = {
  n: number
  createMs?: number
  createAttempts?: number
  createError?: string
  directExit?: number
  directLogs?: string
  directAfterMs?: number
  proxiedCode?: string
  proxiedTries?: number
  proxiedLogs?: string
  deleteMs?: number
  deleteError?: string
}

const errText = (err: unknown): string => {
  if (err instanceof Error) {
    const anyErr = err as Error & { status?: number; body?: unknown; response?: { status?: number } }
    const status = anyErr.status ?? anyErr.response?.status
    const body = anyErr.body ? ` ${JSON.stringify(anyErr.body)}` : ""
    return `${status ? `${status} ` : ""}${err.message}${body}`
  }
  return typeof err === "string" ? err : JSON.stringify(err)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The delete is asynchronous: the API keeps answering 409 SANDBOX_ALREADY_EXISTS
// until the previous sandbox is gone. Retry the create on that 409 only, so the
// new create lands as early as the controlplane accepts it (the pod of the old
// sandbox may still be Terminating: that is the leftover-pod path under test).
async function createWhenGone(tag: string, config: Parameters<typeof SandboxInstance.create>[0], it: Iteration): Promise<SandboxInstance> {
  for (let attempt = 1; ; attempt++) {
    it.createAttempts = attempt
    try {
      return await SandboxInstance.create(config)
    } catch (err) {
      const text = errText(err)
      if (!text.includes("SANDBOX_ALREADY_EXISTS") || attempt >= 30) throw err
      if (attempt === 1) console.log(`${tag} previous sandbox still exists, retrying the create every 500ms`)
      await sleep(500)
    }
  }
}

async function iteration(n: number): Promise<Iteration> {
  const it: Iteration = { n }
  const tag = `[${NAME} #${n}]`
  let sandbox: SandboxInstance | undefined

  const createStart = Date.now()
  try {
    sandbox = await createWhenGone(tag, {
      name: NAME,
      image: IMAGE,
      region: REGION,
      labels: { env: "manual-test", "created-by": "lockdown_boot_race" },
      network: {
        firewall: { rulesets: ["proxy"] },
        allowedDomains: [TARGET_HOST],
        proxy: { routing: [] },
      },
    }, it)
    it.createMs = Date.now() - createStart
    console.log(`${tag} create ok in ${it.createMs}ms (attempts=${it.createAttempts})`)
  } catch (err) {
    it.createMs = Date.now() - createStart
    it.createError = errText(err)
    console.error(`${tag} CREATE REJECTED after ${it.createMs}ms: ${it.createError}`)
    return it
  }

  // 1. boot window: first exec, direct, no warm-up.
  const probeStart = Date.now()
  try {
    const direct = await sandbox.process.exec({ command: DIRECT_PROBE, waitForCompletion: true })
    it.directAfterMs = Date.now() - probeStart
    it.directExit = direct.exitCode
    it.directLogs = (direct.logs ?? "").trim()
    const verdict = direct.exitCode === 0 ? "LEAK (direct egress succeeded)" : direct.exitCode === -1 || direct.exitCode === 124 ? "blocked (dropped, killed by timeout)" : "blocked (refused)"
    console.log(`${tag} direct probe: exit=${direct.exitCode} status=${direct.status} → ${verdict} (${it.directLogs.slice(0, 120)})`)
  } catch (err) {
    it.directLogs = errText(err)
    console.error(`${tag} direct probe exec REJECTED: ${it.directLogs}`)
  }

  // 2. steady state through the proxy, retried while the proxy warms up.
  await sandbox.fs.write(PROXY_PROBE_PATH, PROXY_PROBE_SCRIPT)
  for (let tries = 1; tries <= 10; tries++) {
    it.proxiedTries = tries
    try {
      const proxied = await sandbox.process.exec({ command: PROXIED_PROBE, waitForCompletion: true })
      it.proxiedLogs = (proxied.logs ?? "").trim()
      it.proxiedCode = it.proxiedLogs.split("\n").pop()?.trim()
      if (proxied.exitCode === 0 && it.proxiedCode === "200") break
    } catch (err) {
      it.proxiedLogs = errText(err)
    }
    await sleep(2000)
  }
  console.log(`${tag} proxied probe: http=${it.proxiedCode ?? "-"} after ${it.proxiedTries} tries (${(it.proxiedLogs ?? "").slice(0, 120)})`)

  if (n < ITERATIONS || CLEANUP) {
    const deleteStart = Date.now()
    try {
      await SandboxInstance.delete(NAME)
      it.deleteMs = Date.now() - deleteStart
      console.log(`${tag} delete ok in ${it.deleteMs}ms`)
    } catch (err) {
      it.deleteError = errText(err)
      console.error(`${tag} DELETE REJECTED: ${it.deleteError}`)
    }
  }
  return it
}

// Same direct probe in a sandbox without lockdown: it must succeed, otherwise
// a "blocked" result below proves nothing.
async function control(): Promise<void> {
  const name = `${NAME}-control`
  const tag = `[${name}]`
  const sandbox = await SandboxInstance.create({ name, image: IMAGE, region: REGION, labels: { env: "manual-test", "created-by": "lockdown_boot_race" } })
  try {
    const direct = await sandbox.process.exec({ command: DIRECT_PROBE, waitForCompletion: true })
    const logs = (direct.logs ?? "").trim()
    console.log(`${tag} direct probe without lockdown: exit=${direct.exitCode} (${logs.slice(0, 120)})`)
    if (direct.exitCode !== 0) throw new Error(`control probe failed (exit=${direct.exitCode}): the probe does not reach ${TARGET} even without lockdown`)
  } finally {
    await SandboxInstance.delete(name).catch((err) => console.error(`${tag} DELETE REJECTED: ${errText(err)}`))
  }
}

async function main() {
  console.log(`sandbox=${NAME} region=${REGION} image=${IMAGE} target=${TARGET} iterations=${ITERATIONS}`)
  console.log(`direct probe : ${DIRECT_PROBE}`)
  console.log(`proxied probe: ${PROXIED_PROBE}`)
  if (CONTROL) await control()

  const results: Iteration[] = []
  for (let n = 1; n <= ITERATIONS; n++) {
    results.push(await iteration(n))
    // No pause: the next create must land while the previous pod is still going away.
  }

  console.log("\n#  create(ms/attempts)  direct(exit)  proxied(http/tries)  delete(ms)  errors")
  for (const r of results) {
    const direct = r.directExit === undefined ? "-" : r.directExit === 0 ? "0 LEAK" : String(r.directExit)
    const errors = [r.createError && `create: ${r.createError}`, r.deleteError && `delete: ${r.deleteError}`].filter(Boolean).join(" | ")
    console.log(`${String(r.n).padEnd(2)} ${`${r.createMs ?? "-"}/${r.createAttempts ?? "-"}`.padEnd(20)} ${direct.padEnd(13)} ${`${r.proxiedCode ?? "-"}/${r.proxiedTries ?? "-"}`.padEnd(20)} ${String(r.deleteMs ?? "-").padEnd(11)} ${errors}`)
  }

  const leaks = results.filter((r) => r.directExit === 0).length
  const createFailures = results.filter((r) => r.createError).length
  const notProxied = results.filter((r) => !r.createError && r.proxiedCode !== "200").length
  console.log(`\nleaks=${leaks} createFailures=${createFailures} notReachableViaProxy=${notProxied}`)
  if (leaks || createFailures || notProxied) process.exit(1)
}

main().catch((err) => {
  console.error("Fatal error:", errText(err))
  process.exit(1)
})
