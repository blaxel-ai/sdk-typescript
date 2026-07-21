/**
 * Toggle sandbox standby with the sandbox HTTP API.
 *
 * This script is intended to run inside the sandbox, where the sandbox API is
 * available on http://localhost:8080. For local testing, set SANDBOX_BASE_URL
 * to the remote sandbox URL and SANDBOX_AUTHENTICATION to the auth token.
 *
 * Run:
 *   npx tsx tests/manual/standby.ts disable
 *   npx tsx tests/manual/standby.ts enable
 */

const BASE_URL = process.env.SANDBOX_BASE_URL || "http://localhost:8080"
const AUTHENTICATION = process.env.SANDBOX_AUTHENTICATION

const PROCESS_NAME = "standby-keepalive"
const COMMAND = "while true; do sleep 3600; done"

type SandboxProcess = {
  name: string
  pid: string
  status: string
  keepAlive?: boolean
}

async function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (AUTHENTICATION) headers.set("Authorization", "Bearer "+AUTHENTICATION)
  if (init.body) headers.set("Content-Type", "application/json")

  return await fetch(`${BASE_URL}${path}`, { ...init, headers })
}

async function getKeepaliveProcess(): Promise<SandboxProcess | null> {
  const res = await api(`/process/${PROCESS_NAME}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET /process/${PROCESS_NAME} failed: ${res.status} ${await res.text()}`)
  return await res.json() as SandboxProcess
}

async function killKeepaliveProcess() {
  const res = await api(`/process/${PROCESS_NAME}/kill`, { method: "DELETE" })
  if (res.status === 404) return
  if (!res.ok) throw new Error(`DELETE /process/${PROCESS_NAME}/kill failed: ${res.status} ${await res.text()}`)
}

export async function disableStandby() {
  const existing = await getKeepaliveProcess()
  if (existing?.status === "running") return existing

  if (existing) {
    await killKeepaliveProcess()
  }

  const res = await api("/process", {
    method: "POST",
    body: JSON.stringify({
      name: PROCESS_NAME,
      command: COMMAND,
      keepAlive: true,
      timeout: 0,
      waitForCompletion: false,
    }),
  })

  if (!res.ok) throw new Error(`POST /process failed: ${res.status} ${await res.text()}`)
  return await res.json() as SandboxProcess
}

export async function enableStandby() {
  await killKeepaliveProcess()
}

const action = process.argv[2]
if (action === "disable") {
  const process = await disableStandby()
  console.log(`Standby disabled. Process ${process.name} is ${process.status} with pid ${process.pid}.`)
} else if (action === "enable") {
  await enableStandby()
  console.log("Standby enabled.")
}
