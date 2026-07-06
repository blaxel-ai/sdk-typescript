/**
 * Manual test script for cron expression validation (PR #4730).
 *
 * Exercises the controlplane's API-time cron validation via sandbox schedules:
 *
 *   1. Valid cron expressions are accepted (200/201)
 *   2. Invalid cron expressions are rejected with 400
 *   3. DOW values 0-7 are accepted (0 and 7 = Sunday)
 *   4. Both DOM and DOW set simultaneously is rejected
 *   5. Named days (MON-FRI) and named months (JAN) are accepted
 *
 * Env:
 *   BL_WORKSPACE   workspace name (required)
 *   BL_API_KEY     API key (required)
 *   BL_ENV         "dev" or "prod" (default: prod)
 *   BL_REGION      region (default: us-was-1 for prod, eu-dub-1 for dev)
 *
 * Run:
 *   cd @blaxel/core && npm run build && cd ../..
 *   npx tsx tests/manual/cron_validation.ts
 */
import { SandboxInstance, settings } from "@blaxel/core"
import { v4 as uuidv4 } from "uuid"
 
const env = process.env.BL_ENV || "prod"
const REGION = process.env.BL_REGION || (env === "dev" ? "eu-dub-1" : "us-was-1")
const IMAGE = "blaxel/base-image:latest"
const LABELS = { env: "manual-test", "created-by": "cron-validation-test" }
 
type TestCase = {
  name: string
  schedule: { type: string; value: string; input: { command: string; keepAlive: boolean; timeout: number } }
  expectError: boolean
  errorContains?: string
}
 
const testCases: TestCase[] = [
  // === Valid cron expressions ===
  {
    name: "every minute (* * * * *)",
    schedule: { type: "cron", value: "* * * * *", input: { command: "echo test", keepAlive: true, timeout: 60 } },
    expectError: false,
  },
  {
    name: "every 5 minutes (*/5 * * * *)",
    schedule: { type: "cron", value: "*/5 * * * *", input: { command: "echo test", keepAlive: true, timeout: 60 } },
    expectError: false,
  },
  {
    name: "daily at midnight (0 0 * * *)",
    schedule: { type: "cron", value: "0 0 * * *", input: { command: "echo test", keepAlive: true, timeout: 60 } },
    expectError: false,
  },
  {
    name: "Sunday DOW=0 (0 10 * * 0)",
    schedule: { type: "cron", value: "0 10 * * 0", input: { command: "echo test", keepAlive: true, timeout: 60 } },
    expectError: false,
  },
  {
    name: "Sunday DOW=7 (0 10 * * 7)",
    schedule: { type: "cron", value: "0 10 * * 7", input: { command: "echo test", keepAlive: true, timeout: 60 } },
    expectError: false,
  },
  {
    name: "weekdays range 1-5 (0 9 * * 1-5)",
    schedule: { type: "cron", value: "0 9 * * 1-5", input: { command: "echo test", keepAlive: true, timeout: 60 } },
    expectError: false,
  },
  {
    name: "named days MON-FRI (0 9 * * MON-FRI)",
    schedule: { type: "cron", value: "0 9 * * MON-FRI", input: { command: "echo test", keepAlive: true, timeout: 60 } },
    expectError: false,
  },
  {
    name: "named month (0 0 1 JAN *)",
    schedule: { type: "cron", value: "0 0 1 JAN *", input: { command: "echo test", keepAlive: true, timeout: 60 } },
    expectError: false,
  },
  {
    name: "list of hours (0 8,12,18 * * *)",
    schedule: { type: "cron", value: "0 8,12,18 * * *", input: { command: "echo test", keepAlive: true, timeout: 60 } },
    expectError: false,
  },
  {
    name: "specific DOM (0 0 15 * *)",
    schedule: { type: "cron", value: "0 0 15 * *", input: { command: "echo test", keepAlive: true, timeout: 60 } },
    expectError: false,
  },
  {
    name: "range with step (0 0 1-15/3 * *)",
    schedule: { type: "cron", value: "0 0 1-15/3 * *", input: { command: "echo test", keepAlive: true, timeout: 60 } },
    expectError: false,
  },
  {
    name: "DOW list (0 0 * * 1,3,5)",
    schedule: { type: "cron", value: "0 0 * * 1,3,5", input: { command: "echo test", keepAlive: true, timeout: 60 } },
    expectError: false,
  },
 
  // === Invalid cron expressions (should be rejected with 400) ===
  {
    name: "too few fields (0 0 * *)",
    schedule: { type: "cron", value: "0 0 * *", input: { command: "echo test", keepAlive: true, timeout: 60 } },
    expectError: true,
    errorContains: "expected 5 fields",
  },
  {
    name: "too many fields / 6-field AWS format (0 10 ? * 0 *)",
    schedule: { type: "cron", value: "0 10 ? * 0 *", input: { command: "echo test", keepAlive: true, timeout: 60 } },
    expectError: true,
    errorContains: "expected 5 fields",
  },
  {
    name: "minute out of range (60 0 * * *)",
    schedule: { type: "cron", value: "60 0 * * *", input: { command: "echo test", keepAlive: true, timeout: 60 } },
    expectError: true,
    errorContains: "minute",
  },
  {
    name: "hour out of range (0 25 * * *)",
    schedule: { type: "cron", value: "0 25 * * *", input: { command: "echo test", keepAlive: true, timeout: 60 } },
    expectError: true,
    errorContains: "hour",
  },
  {
    name: "DOM out of range (0 0 32 * *)",
    schedule: { type: "cron", value: "0 0 32 * *", input: { command: "echo test", keepAlive: true, timeout: 60 } },
    expectError: true,
    errorContains: "day-of-month",
  },
  {
    name: "month out of range (0 0 * 13 *)",
    schedule: { type: "cron", value: "0 0 * 13 *", input: { command: "echo test", keepAlive: true, timeout: 60 } },
    expectError: true,
    errorContains: "month",
  },
  {
    name: "DOW out of range (0 0 * * 8)",
    schedule: { type: "cron", value: "0 0 * * 8", input: { command: "echo test", keepAlive: true, timeout: 60 } },
    expectError: true,
    errorContains: "day-of-week",
  },
  {
    name: "invalid step (*/0 * * * *)",
    schedule: { type: "cron", value: "*/0 * * * *", input: { command: "echo test", keepAlive: true, timeout: 60 } },
    expectError: true,
    errorContains: "step",
  },
  {
    name: "invalid range (0 0 * * 5-3)",
    schedule: { type: "cron", value: "0 0 * * 5-3", input: { command: "echo test", keepAlive: true, timeout: 60 } },
    expectError: true,
    errorContains: "range",
  },
  {
    name: "all out of range (99 99 99 99 99)",
    schedule: { type: "cron", value: "99 99 99 99 99", input: { command: "echo test", keepAlive: true, timeout: 60 } },
    expectError: true,
  },
 
  // === DOM + DOW both set (should be rejected) ===
  {
    name: "DOM + DOW both set (0 10 15 * 1)",
    schedule: { type: "cron", value: "0 10 15 * 1", input: { command: "echo test", keepAlive: true, timeout: 60 } },
    expectError: true,
    errorContains: "day-of-month and day-of-week",
  },
  {
    name: "DOM + DOW both set with names (0 10 15 * MON)",
    schedule: { type: "cron", value: "0 10 15 * MON", input: { command: "echo test", keepAlive: true, timeout: 60 } },
    expectError: true,
    errorContains: "day-of-month and day-of-week",
  },
  {
    name: "DOM range + DOW range (0 10 1-15 * 1-5)",
    schedule: { type: "cron", value: "0 10 1-15 * 1-5", input: { command: "echo test", keepAlive: true, timeout: 60 } },
    expectError: true,
    errorContains: "day-of-month and day-of-week",
  },
]
 
type TestResult = {
  name: string
  passed: boolean
  detail: string
}
 
/**
 * Stringify any thrown value into something grep-able.
 * The hey-api client with throwOnError throws the parsed JSON response body
 * directly (a plain object, not an Error). JSON.stringify gives the most
 * reliable result; we also try common `.message` / `.error` fields first.
 */
function errorToString(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  // JSON.stringify handles plain objects (the common case for hey-api throws).
  try {
    const s = JSON.stringify(err)
    if (s && s !== "{}" && s !== "undefined") return s
  } catch { /* circular ref — fall through */ }
  return String(err)
}
 
async function runTest(sandbox: SandboxInstance, tc: TestCase): Promise<TestResult> {
  try {
    const created = await sandbox.schedules.create(tc.schedule as never)
 
    if (tc.expectError) {
      // Clean up the unexpectedly created schedule
      if (created.id) {
        await sandbox.schedules.delete(created.id).catch(() => {})
      }
      return { name: tc.name, passed: false, detail: "expected error but schedule was created" }
    }
 
    // Valid case: clean up
    if (created.id) {
      await sandbox.schedules.delete(created.id).catch(() => {})
    }
    return { name: tc.name, passed: true, detail: "accepted as expected" }
  } catch (err: unknown) {
    // The hey-api client with throwOnError throws the parsed response body
    // (a plain object). Stringify it so we can search for substrings.
    const msg = errorToString(err)
 
    if (!tc.expectError) {
      return { name: tc.name, passed: false, detail: `unexpected error: ${msg}` }
    }
 
    // Check if the error matches what we expect
    if (tc.errorContains && !msg.toLowerCase().includes(tc.errorContains.toLowerCase())) {
      return {
        name: tc.name,
        passed: false,
        detail: `error doesn't contain "${tc.errorContains}": ${msg}`,
      }
    }
 
    // Verify it's a 400 (not a 500 or other error)
    const is400 = msg.includes("400") || msg.includes("Bad Request") || msg.includes("invalid")
    if (!is400) {
      return {
        name: tc.name,
        passed: false,
        detail: `expected 400 but got different error: ${msg}`,
      }
    }
 
    return { name: tc.name, passed: true, detail: `rejected with 400 as expected` }
  }
}
 
async function main() {
  if (!settings.workspace || !settings.authorization) {
    console.error("BL_WORKSPACE and BL_API_KEY must be set.")
    process.exit(2)
  }
 
  console.log()
  console.log("Cron Expression Validation Test (PR #4730)")
  console.log("=".repeat(60))
  console.log(`  workspace: ${settings.workspace}`)
  console.log(`  region:    ${REGION}`)
  console.log(`  env:       ${env}`)
  console.log(`  tests:     ${testCases.length}`)
  console.log()
 
  // Create a sandbox to test schedules against
  const sandboxName = `cron-test-${uuidv4().replace(/-/g, "").substring(0, 8)}`
  console.log(`Creating sandbox ${sandboxName}...`)
 
  let sandbox: SandboxInstance
  try {
    sandbox = await SandboxInstance.create({
      name: sandboxName,
      image: IMAGE,
      region: REGION,
      memory: 2048,
      labels: LABELS,
    })
    console.log(`Sandbox created.\n`)
  } catch (err) {
    console.error(`Failed to create sandbox: ${errorToString(err)}`)
    process.exit(1)
  }
 
  const results: TestResult[] = []
  let passed = 0
  let failed = 0
 
  for (const tc of testCases) {
    const result = await runTest(sandbox, tc)
    results.push(result)
    const icon = result.passed ? "PASS" : "FAIL"
    console.log(`  [${icon}] ${result.name}`)
    if (!result.passed) {
      console.log(`         ${result.detail}`)
    }
    if (result.passed) passed++
    else failed++
  }
 
  // Cleanup
  console.log(`\nDeleting sandbox ${sandboxName}...`)
  try {
    await SandboxInstance.delete(sandboxName)
    console.log("Sandbox deleted.")
  } catch {
    console.warn("Warning: failed to delete sandbox (may need manual cleanup)")
  }
 
  // Summary
  console.log()
  console.log("=".repeat(60))
  console.log(`RESULTS: ${passed} passed, ${failed} failed out of ${results.length} tests`)
  console.log("=".repeat(60))
 
  if (failed > 0) {
    console.log("\nFailed tests:")
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  - ${r.name}: ${r.detail}`)
    }
  }
 
  console.log()
  process.exit(failed > 0 ? 1 : 0)
}
 
main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
