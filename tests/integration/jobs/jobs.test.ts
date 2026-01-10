import { describe, it, expect, beforeAll } from 'vitest'
import { blJob, getJob, settings } from "@blaxel/core"

/**
 * Jobs API Integration Tests
 *
 * Note: These tests require a job named "mk3" to exist in your workspace.
 * The job should accept tasks with a "duration" field.
 */

const TEST_JOB_NAME = "mk3"

async function checkJobExists(jobName: string): Promise<boolean> {
  try {
    const { data } = await getJob({
      path: { jobId: jobName },
      headers: settings.headers,
      throwOnError: false,
    })
    return !!data
  } catch {
    return false
  }
}

describe('Jobs API Integration', () => {
  let jobExists = false

  beforeAll(async () => {
    jobExists = await checkJobExists(TEST_JOB_NAME)
    if (!jobExists) {
      console.warn(`[SKIP] Job "${TEST_JOB_NAME}" does not exist. Skipping Jobs API Integration tests.`)
    }
  })

  describe('blJob', () => {
    it('can create a job reference', ({ skip }) => {
      if (!jobExists) return skip()

      const job = blJob(TEST_JOB_NAME)

      expect(job).toBeDefined()
      expect(typeof job.createExecution).toBe('function')
      expect(typeof job.getExecution).toBe('function')
      expect(typeof job.listExecutions).toBe('function')
    })
  })

  describe('Job Executions', () => {
    it('can create, get, and list execution', async ({ skip }) => {
      if (!jobExists) return skip()

      const job = blJob(TEST_JOB_NAME)

      // Create execution
      const executionId = await job.createExecution({
        tasks: [
          { name: "Richard" },
          { name: "John" },
        ],
      })

      expect(executionId).toBeDefined()
      expect(typeof executionId).toBe('string')

      // Get execution details
      const execution = await job.getExecution(executionId)

      expect(execution).toBeDefined()
      expect(execution.status).toBeDefined()
      expect(execution.metadata).toBeDefined()

      // Get execution status
      const status = await job.getExecutionStatus(executionId)

      expect(status).toBeDefined()
      expect(typeof status).toBe('string')

      // List executions (should include the one we just created)
      const executions = await job.listExecutions()

      expect(executions).toBeDefined()
      expect(Array.isArray(executions)).toBe(true)
      expect(executions.length).toBeGreaterThan(0)
    })

    it('can wait for execution to complete', async ({ skip }) => {
      if (!jobExists) return skip()

      const job = blJob(TEST_JOB_NAME)

      const executionId = await job.createExecution({
        tasks: [{ name: "Richard" }, { name: "John" }],
      })

      const completedExecution = await job.waitForExecution(executionId, {
        maxWait: 60000, // 1 minute
        interval: 1000, // 1 second
      })

      expect(completedExecution).toBeDefined()
      expect(['completed', 'succeeded', 'failed', 'cancelled']).toContain(completedExecution.status)
    })

    it('can run job and wait for completion', async ({ skip }) => {
      if (!jobExists) return skip()

      const job = blJob(TEST_JOB_NAME)

      const result = await job.run([{ name: "Richard" }, { name: "John" }])

      expect(result).toBeDefined()
    })
  })
})
