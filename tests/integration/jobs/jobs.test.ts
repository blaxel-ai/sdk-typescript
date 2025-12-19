import { describe, it, expect } from 'vitest'
import { blJob } from "@blaxel/core"

/**
 * Jobs API Integration Tests
 *
 * Note: These tests require a job named "mk3" to exist in your workspace.
 * The job should accept tasks with a "duration" field.
 */

const TEST_JOB_NAME = "mk3"

describe('Jobs API Integration', () => {
  describe('blJob', () => {
    it('can create a job reference', () => {
      const job = blJob(TEST_JOB_NAME)

      expect(job).toBeDefined()
      expect(typeof job.createExecution).toBe('function')
      expect(typeof job.getExecution).toBe('function')
      expect(typeof job.listExecutions).toBe('function')
    })
  })

  describe('Job Executions', () => {
    it('can create an execution', async () => {
      const job = blJob(TEST_JOB_NAME)

      const executionId = await job.createExecution({
        tasks: [
          { duration: 10 },
          { duration: 10 },
        ],
      })

      expect(executionId).toBeDefined()
      expect(typeof executionId).toBe('string')
    })

    it('can get execution details', async () => {
      const job = blJob(TEST_JOB_NAME)

      const executionId = await job.createExecution({
        tasks: [{ duration: 5 }],
      })

      const execution = await job.getExecution(executionId)

      expect(execution).toBeDefined()
      expect(execution.status).toBeDefined()
      expect(execution.metadata).toBeDefined()
    })

    it('can get execution status', async () => {
      const job = blJob(TEST_JOB_NAME)

      const executionId = await job.createExecution({
        tasks: [{ duration: 5 }],
      })

      const status = await job.getExecutionStatus(executionId)

      expect(status).toBeDefined()
      expect(typeof status).toBe('string')
    })

    it('can list executions', async () => {
      const job = blJob(TEST_JOB_NAME)

      // Create an execution first
      await job.createExecution({
        tasks: [{ duration: 5 }],
      })

      const executions = await job.listExecutions()

      expect(executions).toBeDefined()
      expect(Array.isArray(executions)).toBe(true)
      expect(executions.length).toBeGreaterThan(0)
    })

    it('can wait for execution to complete', async () => {
      const job = blJob(TEST_JOB_NAME)

      const executionId = await job.createExecution({
        tasks: [{ duration: 5 }],
      })

      const completedExecution = await job.waitForExecution(executionId, {
        maxWait: 60000, // 1 minute
        interval: 1000, // 1 second
      })

      expect(completedExecution).toBeDefined()
      expect(['completed', 'succeeded', 'failed', 'cancelled']).toContain(completedExecution.status)
    })
  })

  describe('Job run (convenience method)', () => {
    it('can run job and wait for completion', async () => {
      const job = blJob(TEST_JOB_NAME)

      const result = await job.run([{ duration: 5 }])

      expect(result).toBeDefined()
    })
  })
})

