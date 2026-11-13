import { SandboxInstance } from "@blaxel/core"

const testRunId = process.env.BL_TEST_RUN_ID

export function belongsToTestRun(labels: Record<string, string> | undefined, runId: string | undefined): boolean {
  return !!runId &&
    labels?.env === "integration-test" &&
    labels.language === "typescript" &&
    labels["created-by"] === "vitest-integration" &&
    labels["test-run-id"] === runId
}

// Remove child previews before their parent so they don't consume quota after teardown.
export async function deleteTestSandbox(name: string, runId = testRunId): Promise<void> {
  if (process.env.SKIP_CLEANUP === "1" || !runId || !name) return

  const sandbox = await SandboxInstance.get(name)
  if (!belongsToTestRun(sandbox.metadata.labels, runId)) return

  const errors: unknown[] = []
  try {
    const previews = await sandbox.previews.list()
    const results = await Promise.allSettled(previews.map(preview => sandbox.previews.delete(preview.name)))
    for (const result of results) {
      if (result.status === "rejected") errors.push(result.reason as unknown)
    }
  } catch (error) {
    errors.push(error)
  }

  try {
    if (sandbox.status !== "TERMINATED") await SandboxInstance.delete(name)
  } catch (error) {
    errors.push(error)
  }
  if (errors.length) {
    throw new AggregateError(errors, `Failed to clean test sandbox ${name}`)
  }
}
