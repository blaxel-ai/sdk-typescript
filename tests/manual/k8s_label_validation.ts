/**
 * Reproducer for K8s label validation failure.
 *
 * Kubernetes enforces that label values match:
 *   (([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?
 * and are max 63 characters.
 *
 * The controlplane stores customer labels and passes them to K8s without
 * validation/sanitization, causing pod creation to fail when labels contain
 * invalid characters (spaces, special chars, etc.).
 *
 * This test creates a sandbox with various invalid label values to reproduce
 * the issue. After the fix (controlplane#4589), these should either:
 *   - Be rejected at the API level with a 400 error (validation), OR
 *   - Be sanitized at the K8s boundary (defense-in-depth)
 *
 * Env:
 *   BL_WORKSPACE    Blaxel workspace (required)
 *   BL_API_KEY      Blaxel API key (required)
 *   IMAGE           Sandbox image (default: blaxel/base-image:latest)
 *   BL_REGION       Region (default: us-was-1)
 *
 * Run:
 *   cd @blaxel/core && npm run build && cd ../..
 *   npx tsx tests/manual/k8s_label_validation.ts
 */
import { SandboxInstance, settings } from "@blaxel/core"

const IMAGE = process.env.IMAGE || "blaxel/base-image:latest"
const REGION = process.env.BL_REGION || "us-was-1"
const CLEANUP_LABELS = { env: "manual-test", "created-by": "k8s-label-validation-repro" }

type TestCase = {
  name: string
  labels: Record<string, string>
  expectFailure: boolean
  description: string
}

const TEST_CASES: TestCase[] = [
  {
    name: "space-in-value",
    labels: { company: "AB Airbags" },
    expectFailure: true,
    description: "Space in label value (original reported bug)",
  },
  {
    name: "special-chars",
    labels: { tag: "foo@bar#baz" },
    expectFailure: true,
    description: "Special characters (@, #) in label value",
  },
  {
    name: "starts-with-dash",
    labels: { version: "-beta" },
    expectFailure: true,
    description: "Label value starting with dash (must start with alphanumeric)",
  },
  {
    name: "ends-with-dot",
    labels: { release: "v1.0." },
    expectFailure: true,
    description: "Label value ending with dot (must end with alphanumeric)",
  },
  {
    name: "long-value",
    labels: { description: "a".repeat(64) },
    expectFailure: true,
    description: "Label value exceeding 63 characters",
  },
  {
    name: "valid-labels",
    labels: { env: "production", version: "v1.2.3", tier: "backend_service" },
    expectFailure: false,
    description: "Valid label values (should always succeed)",
  },
  {
    name: "unicode-value",
    labels: { team: "equipe-developement" },
    expectFailure: false,
    description: "ASCII-safe value that looks like it could have accents",
  },
]

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

async function safeDelete(name: string): Promise<void> {
  try {
    await SandboxInstance.delete(name)
  } catch {
    // already gone
  }
}

type Result = {
  testCase: TestCase
  sandboxName: string
  outcome: "CREATED" | "API_REJECTED" | "K8S_FAILED" | "OTHER_ERROR"
  error?: string
  processExecOk?: boolean
}

async function runTest(tc: TestCase): Promise<Result> {
  const sandboxName = uid(`lbl-${tc.name}`)
  const allLabels = { ...CLEANUP_LABELS, ...tc.labels }

  console.log(`\n--- Test: ${tc.name} ---`)
  console.log(`  Description: ${tc.description}`)
  console.log(`  Labels: ${JSON.stringify(tc.labels)}`)
  console.log(`  Sandbox: ${sandboxName}`)

  try {
    const sbx = await SandboxInstance.create(
      {
        name: sandboxName,
        image: IMAGE,
        labels: allLabels,
        memory: 2048,
        region: REGION,
        ports: [{ name: "sandbox-api", protocol: "HTTP", target: 8080 }],
      },
      { safe: true }
    )

    console.log(`  -> CREATED (status=${sbx.status})`)

    // Try to exec to verify the sandbox is actually functional
    let processExecOk = false
    const sandboxUrl = sbx.metadata.url
    if (sandboxUrl) {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        try {
          const res = await globalThis.fetch(`${sandboxUrl}/process`, {
            method: "POST",
            headers: { ...settings.headers, "Content-Type": "application/json" },
            body: JSON.stringify({ command: "echo ok", waitForCompletion: true, timeout: 10 }),
          })
          if (res.status < 400) {
            processExecOk = true
            break
          }
          const body = await res.text()
          if (body.includes("WORKLOAD_UNAVAILABLE") || body.includes("k8s_deployment_pipeline failed")) {
            // K8s label failure manifests here
            console.log(`  -> K8S_FAILED (workload never became available)`)
            console.log(`     Error: ${body.slice(0, 200)}`)
            await safeDelete(sandboxName)
            return { testCase: tc, sandboxName, outcome: "K8S_FAILED", error: body.slice(0, 300) }
          }
        } catch {
          // retry
        }
        await new Promise((r) => setTimeout(r, 1000))
      }

      if (processExecOk) {
        console.log(`  -> Process exec OK (sandbox fully functional)`)
      } else {
        console.log(`  -> Process exec TIMEOUT (sandbox may have K8s issues)`)
      }
    }

    await safeDelete(sandboxName)
    return { testCase: tc, sandboxName, outcome: "CREATED", processExecOk }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const isApiRejection = msg.includes("400") || msg.includes("invalid") || msg.includes("must consist of")

    if (isApiRejection) {
      console.log(`  -> API_REJECTED (400): ${msg.slice(0, 200)}`)
      return { testCase: tc, sandboxName, outcome: "API_REJECTED", error: msg }
    }

    console.log(`  -> OTHER_ERROR: ${msg.slice(0, 200)}`)
    await safeDelete(sandboxName)
    return { testCase: tc, sandboxName, outcome: "OTHER_ERROR", error: msg }
  }
}

async function main() {
  if (!settings.workspace || !settings.authorization) {
    console.error("BL_WORKSPACE and BL_API_KEY must be set.")
    process.exit(2)
  }

  console.log("=" .repeat(72))
  console.log("K8s Label Validation Reproducer")
  console.log("=" .repeat(72))
  console.log(`  workspace=${settings.workspace}`)
  console.log(`  image=${IMAGE}`)
  console.log(`  region=${REGION}`)
  console.log()
  console.log("Expected behavior BEFORE fix:")
  console.log("  - Invalid labels pass API validation but K8s rejects the pod")
  console.log("  - Sandbox status shows deployment pipeline failure")
  console.log()
  console.log("Expected behavior AFTER fix (controlplane#4589):")
  console.log("  - Invalid labels are either rejected at API (400) or sanitized")
  console.log("  - Sandbox creates successfully with sanitized label values")

  const results: Result[] = []
  for (const tc of TEST_CASES) {
    results.push(await runTest(tc))
  }

  console.log("\n")
  console.log("=" .repeat(72))
  console.log("RESULTS SUMMARY")
  console.log("=" .repeat(72))
  console.log()

  const colName = 25
  const colOutcome = 14
  const colExpect = 12

  console.log(
    "  " +
    "Test".padEnd(colName) +
    "Outcome".padEnd(colOutcome) +
    "Expected".padEnd(colExpect) +
    "Pass?"
  )
  console.log("  " + "-".repeat(colName + colOutcome + colExpect + 6))

  let allPass = true
  for (const r of results) {
    const expected = r.testCase.expectFailure ? "FAIL/SANITIZE" : "CREATE"
    let pass: boolean

    if (r.testCase.expectFailure) {
      // After fix: either API rejects (API_REJECTED) or sandbox creates with sanitized values (CREATED + processExecOk)
      // Before fix: K8S_FAILED
      pass = r.outcome === "API_REJECTED" || (r.outcome === "CREATED" && r.processExecOk === true)
    } else {
      pass = r.outcome === "CREATED" && r.processExecOk === true
    }

    if (!pass) allPass = false

    console.log(
      "  " +
      r.testCase.name.padEnd(colName) +
      r.outcome.padEnd(colOutcome) +
      expected.padEnd(colExpect) +
      (pass ? "YES" : "NO <---")
    )
  }

  console.log()
  if (allPass) {
    console.log("All tests passed! The fix is working correctly.")
  } else {
    console.log("Some tests did NOT pass. See details above.")
    console.log()
    console.log("If outcome is K8S_FAILED for invalid labels -> the fix is NOT deployed yet.")
    console.log("If outcome is API_REJECTED or CREATED+exec_ok -> the fix is working.")
  }

  console.log()
  process.exit(allPass ? 0 : 1)
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
