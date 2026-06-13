import type { SandboxInstance as SandboxInstanceType } from "@blaxel/core"

process.env.BL_DISABLE_H2 ??= "true"

const SANDBOX_NAME = process.env.SANDBOX_NAME || "docker-in-sandbox"
const PREVIEW_NAME = process.env.PREVIEW_NAME || "docker-nginx-preview"
const IMAGE = process.env.IMAGE || "blaxel/docker-in-sandbox:latest"
const REGION = process.env.BL_REGION || "us-pdx-1"
const TTL = process.env.TTL || "7d"
const MEMORY_MB = parseInt(process.env.MEMORY_MB || "4096", 10)
const PREVIEW_PORT = parseInt(process.env.PREVIEW_PORT || "3000", 10)
const IS_PRIVATE = (process.env.PRIVATE ?? "false") === "true"
const DOCKER_READY_TIMEOUT_MS = parseInt(process.env.DOCKER_READY_TIMEOUT_MS || "60000", 10)
const DOCKER_RUN_TIMEOUT_SECONDS = parseInt(process.env.DOCKER_RUN_TIMEOUT_SECONDS || "300", 10)
const LABELS = { env: "manual-test", "created-by": "docker-in-sandbox-preview" }
const BLAXEL_RESPONSE_HEADERS: Record<string, string> = {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForPreview(url: string, timeoutMs = 60_000): Promise<Response> {
  const startedAt = Date.now()
  let lastError: unknown

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) return response
      lastError = new Error(`HTTP ${response.status}: ${await response.text()}`)
    } catch (err) {
      lastError = err
    }

    await sleep(1_000)
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`Preview did not become ready after ${timeoutMs}ms: ${message}`)
}

async function waitForDocker(sandbox: SandboxInstanceType): Promise<void> {
  const startedAt = Date.now()
  let lastError = "docker info did not complete"

  while (Date.now() - startedAt < DOCKER_READY_TIMEOUT_MS) {
    const result = await sandbox.process.exec({
      name: "docker-ready",
      command: "docker info >/dev/null 2>&1",
      waitForCompletion: true,
      timeout: 10,
    }).catch((err: unknown) => {
      lastError = err instanceof Error ? err.message : String(err)
      return null
    })

    if (result?.status === "completed") return
    lastError = result?.stderr || result?.logs || `docker info status: ${result?.status ?? "unknown"}`
    await sleep(1_000)
  }

  throw new Error(`Docker daemon did not become ready after ${DOCKER_READY_TIMEOUT_MS}ms: ${lastError}`)
}

async function main() {
  const { SandboxInstance } = await import("@blaxel/core")

  console.log(`Creating sandbox ${SANDBOX_NAME} with ${IMAGE} in ${REGION}...`)
  const sandbox = await SandboxInstance.createIfNotExists({
    name: SANDBOX_NAME,
    image: IMAGE,
    memory: MEMORY_MB,
    region: REGION,
    ttl: TTL,
    ports: [
      { name: "sandbox-api", protocol: "HTTP", target: 8080 },
      { name: "notes-api", protocol: "HTTP", target: PREVIEW_PORT },
    ],
    labels: LABELS,
  })

  console.log(`Sandbox URL: ${sandbox.metadata.url}`)
  console.log("Waiting for Docker daemon...")
  await waitForDocker(sandbox)

  console.log("Starting nginx in Docker on sandbox port 3000...")
  const dockerRun = await sandbox.process.exec({
    name: "start-nginx",
    command: [
      "docker rm -f my-nginx >/dev/null 2>&1 || true",
      `docker run --name my-nginx -p ${PREVIEW_PORT}:80 -d nginx`,
    ].join(" && "),
    waitForCompletion: true,
    timeout: DOCKER_RUN_TIMEOUT_SECONDS,
  })

  if (dockerRun.status && dockerRun.status !== "completed") {
    throw new Error(`docker run failed with status ${dockerRun.status}: ${dockerRun.stderr ?? dockerRun.logs ?? ""}`)
  }

  console.log("Creating preview with Connection: close response header...")
  await sandbox.previews.delete(PREVIEW_NAME).catch(() => {})
  const preview = await sandbox.previews.create({
    metadata: {
      name: PREVIEW_NAME,
    },
    spec: {
      port: PREVIEW_PORT,
      public: !IS_PRIVATE,
      prefixUrl: SANDBOX_NAME,
      requestHeaders: {
        Connection: "close",
      },
    },
  })

  if (!preview.spec.url) {
    throw new Error("Preview was created without a URL")
  }

  const response = await waitForPreview(preview.spec.url)
  const body = await response.text()

  console.log(`Preview URL: ${preview.spec.url}`)
  console.log(`Preview status: ${response.status}`)
  console.log(`Preview connection header: ${response.headers.get("connection")}`)
  console.log(`Preview body includes nginx welcome page: ${body.includes("Welcome to nginx!")}`)
  console.log("")
  console.log("Run with:")
  console.log("  npx tsx tests/manual/docker.ts")
  console.log("")
  console.log("Cleanup with:")
  console.log(`  npx tsx -e 'import { SandboxInstance } from "@blaxel/core"; await SandboxInstance.delete("${SANDBOX_NAME}")'`)
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
