import { blJob, getJob, settings } from "@blaxel/core"
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * Jobs API Integration Tests
 *
 * Note: These tests require a job named "mk3" to exist in your workspace.
 * The job should accept tasks with a "duration" field.
 */

const TEST_JOB_NAME = "mk3"

/**
 * Check if an error is due to maximum parallel executions limit
 */
function isMaxParallelExecutionsError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'error' in error) {
    const errorObj = error as { error?: string }
    return errorObj.error?.includes('Maximum parallel executions limit reached') ?? false
  }
  if (error instanceof Error) {
    return error.message.includes('Maximum parallel executions limit reached')
  }
  return false
}

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
      let executionId: string
      try {
        executionId = await job.createExecution({
          tasks: [
            { name: "Richard" },
            { name: "John" },
          ],
        })
      } catch (error) {
        if (isMaxParallelExecutionsError(error)) {
          console.warn('[SKIP] Maximum parallel executions limit reached')
          return skip()
        }
        throw error
      }

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

      let executionId: string
      try {
        executionId = await job.createExecution({
          tasks: [{ name: "Richard" }, { name: "John" }],
        })
      } catch (error) {
        if (isMaxParallelExecutionsError(error)) {
          console.warn('[SKIP] Maximum parallel executions limit reached')
          return skip()
        }
        throw error
      }

      const completedExecution = await job.waitForExecution(executionId, {
        maxWait: 60000, // 1 minute
        interval: 1000, // 1 second
      })

      expect(completedExecution).toBeDefined()
      expect(['completed', 'succeeded', 'failed', 'cancelled']).toContain(completedExecution.status)
    })

    it('can run job without overrides', async ({ skip }) => {
      if (!jobExists) return skip()

      const job = blJob(TEST_JOB_NAME)

      let executionId: string
      try {
        executionId = await job.run([{ name: "Richard" }, { name: "John" }])
      } catch (error) {
        if (isMaxParallelExecutionsError(error)) {
          console.warn('[SKIP] Maximum parallel executions limit reached')
          return skip()
        }
        throw error
      }

      expect(executionId).toBeDefined()
      expect(typeof executionId).toBe('string')

      // Verify execution was created
      const execution = await job.getExecution(executionId)
      expect(execution).toBeDefined()
      expect(execution.status).toBeDefined()
    })

    it('can run job with memory override', async ({ skip }) => {
      if (!jobExists) return skip()

      const job = blJob(TEST_JOB_NAME)

      let executionId: string
      try {
        executionId = await job.run(
          [{ name: "MemoryTest" }],
          { memory: 2048 }
        )
      } catch (error) {
        if (isMaxParallelExecutionsError(error)) {
          console.warn('[SKIP] Maximum parallel executions limit reached')
          return skip()
        }
        throw error
      }

      expect(executionId).toBeDefined()
      expect(typeof executionId).toBe('string')

      // Verify execution was created
      const execution = await job.getExecution(executionId)
      expect(execution).toBeDefined()
      expect(execution.status).toBeDefined()
    })

    it('can run job with env overrides', async ({ skip }) => {
      if (!jobExists) return skip()

      const job = blJob(TEST_JOB_NAME)

      let executionId: string
      try {
        executionId = await job.run(
          [{ name: "EnvTest" }],
          {
            env: {
              CUSTOM_VAR: "test_value",
              DEBUG_MODE: "true",
            },
          }
        )
      } catch (error) {
        if (isMaxParallelExecutionsError(error)) {
          console.warn('[SKIP] Maximum parallel executions limit reached')
          return skip()
        }
        throw error
      }

      expect(executionId).toBeDefined()
      expect(typeof executionId).toBe('string')

      // Verify execution was created
      const execution = await job.getExecution(executionId)
      expect(execution).toBeDefined()
      expect(execution.status).toBeDefined()
    })

    it('can run job with both memory and env overrides', async ({ skip }) => {
      if (!jobExists) return skip()

      const job = blJob(TEST_JOB_NAME)

      let executionId: string
      try {
        executionId = await job.run(
          [{ name: "CombinedTest" }],
          {
            memory: 1024,
            env: {
              TEST_ENV: "production",
              LOG_LEVEL: "info",
            },
          }
        )
      } catch (error) {
        if (isMaxParallelExecutionsError(error)) {
          console.warn('[SKIP] Maximum parallel executions limit reached')
          return skip()
        }
        throw error
      }

      expect(executionId).toBeDefined()
      expect(typeof executionId).toBe('string')

      // Verify execution was created
      const execution = await job.getExecution(executionId)
      expect(execution).toBeDefined()
      expect(execution.status).toBeDefined()
    })

    it('can create execution with memory override', async ({ skip }) => {
      if (!jobExists) return skip()

      const job = blJob(TEST_JOB_NAME)

      // Create execution with memory override (2048 MB = 2 GB)
      let executionId: string
      try {
        executionId = await job.createExecution({
          tasks: [{ name: "Richard" }],
          memory: 2048,
        })
      } catch (error) {
        if (isMaxParallelExecutionsError(error)) {
          console.warn('[SKIP] Maximum parallel executions limit reached')
          return skip()
        }
        throw error
      }

      expect(executionId).toBeDefined()
      expect(typeof executionId).toBe('string')

      // Verify execution was created
      const execution = await job.getExecution(executionId)
      expect(execution).toBeDefined()
      expect(execution.status).toBeDefined()
    })

    it('can create execution with env overrides', async ({ skip }) => {
      if (!jobExists) return skip()

      const job = blJob(TEST_JOB_NAME)

      // Create execution with environment variable overrides
      let executionId: string
      try {
        executionId = await job.createExecution({
          tasks: [{ name: "John" }],
          env: {
            CUSTOM_ENV: "OVERRIDE_VALUE",
            ANOTHER_ENV: "TEST_VALUE",
          },
        })
      } catch (error) {
        if (isMaxParallelExecutionsError(error)) {
          console.warn('[SKIP] Maximum parallel executions limit reached')
          return skip()
        }
        throw error
      }

      expect(executionId).toBeDefined()
      expect(typeof executionId).toBe('string')

      // Verify execution was created
      const execution = await job.getExecution(executionId)
      expect(execution).toBeDefined()
      expect(execution.status).toBeDefined()
    })

    it('can create execution with both memory and env overrides', async ({ skip }) => {
      if (!jobExists) return skip()

      const job = blJob(TEST_JOB_NAME)

      // Create execution with both memory and environment overrides
      let executionId: string
      try {
        executionId = await job.createExecution({
          tasks: [{ name: "Combined" }],
          memory: 1024,
          env: {
            TEST_MODE: "true",
            LOG_LEVEL: "debug",
          },
        })
      } catch (error) {
        if (isMaxParallelExecutionsError(error)) {
          console.warn('[SKIP] Maximum parallel executions limit reached')
          return skip()
        }
        throw error
      }

      expect(executionId).toBeDefined()
      expect(typeof executionId).toBe('string')

      // Verify execution was created
      const execution = await job.getExecution(executionId)
      expect(execution).toBeDefined()
      expect(execution.status).toBeDefined()
    })
  })
})
