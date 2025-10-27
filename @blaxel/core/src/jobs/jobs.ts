import {
  createJobExecution,
  CreateJobExecutionRequest,
  deleteJobExecution,
  getJobExecution,
  JobExecution,
  listJobExecutions,
} from "../client/index.js";
import { getForcedUrl, getGlobalUniqueHash } from "../common/internal.js";
import { logger } from "../common/logger.js";
import { settings } from "../common/settings.js";
import { startSpan } from "../telemetry/telemetry.js";

class BlJob {
  jobName: string;
  constructor(jobName: string) {
    this.jobName = jobName;
  }

  get fallbackUrl() {
    if (this.externalUrl != this.url) {
      return this.externalUrl;
    }
    return null;
  }

  get externalUrl() {
    return new URL(
      `${settings.runUrl}/${settings.workspace}/jobs/${this.jobName}`,
    );
  }

  get internalUrl() {
    const hash = getGlobalUniqueHash(settings.workspace, "job", this.jobName);
    return new URL(
      `${settings.runInternalProtocol}://bl-${settings.env}-${hash}.${settings.runInternalHostname}`,
    );
  }

  get forcedUrl() {
    return getForcedUrl("job", this.jobName);
  }

  get url() {
    if (this.forcedUrl) return this.forcedUrl;
    if (settings.runInternalHostname) return this.internalUrl;
    return this.externalUrl;
  }

  async call(url: URL, tasks: Record<string, unknown>[]): Promise<Response> {
    const body = {
      tasks: tasks,
    };
    const response = await fetch(url.toString() + "/executions", {
      method: "POST",
      headers: {
        ...settings.headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return response;
  }

  async run(tasks: Record<string, unknown>[]): Promise<string> {
    logger.debug(`Job Calling: ${this.jobName}`);

    const span = startSpan(this.jobName, {
      attributes: {
        "job.name": this.jobName,
        "span.type": "job.run",
      },
      isRoot: false,
    });

    try {
      const response = await this.call(this.url, tasks);
      return await response.text();
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (!this.fallbackUrl) {
          span.setAttribute("job.run.error", err.stack as string);
          throw err;
        }
        try {
          const response = await this.call(this.fallbackUrl, tasks);
          return await response.text();
        } catch (err: unknown) {
          if (err instanceof Error) {
            span.setAttribute("job.run.error", err.stack as string);
          }
          throw err;
        }
      }
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Create a new execution for this job and return the execution ID
   */
  async createExecution(request: CreateJobExecutionRequest): Promise<string> {
    logger.debug(`Creating execution for job: ${this.jobName}`);

    const { data } = await createJobExecution({
      path: {
        jobId: this.jobName,
      },
      body: request,
      headers: settings.headers,
      throwOnError: true,
    });

    // The API returns executionId at the root level, not in metadata
    interface CreateJobExecutionApiResponse {
      executionId?: string;
    }
    const response = data as CreateJobExecutionApiResponse;
    if (!response?.executionId) {
      throw new Error("No execution ID returned from create job execution");
    }

    logger.debug(`Created execution: ${response.executionId}`);
    return response.executionId;
  }

  /**
   * Get a specific execution by ID
   */
  async getExecution(executionId: string): Promise<JobExecution> {
    logger.debug(`Getting execution ${executionId} for job: ${this.jobName}`);

    const { data } = await getJobExecution({
      path: {
        jobId: this.jobName,
        executionId: executionId,
      },
      headers: settings.headers,
      throwOnError: true,
    });

    if (!data) {
      throw new Error(
        `Execution '${executionId}' not found for job '${this.jobName}'`,
      );
    }

    return data;
  }

  /**
   * List all executions for this job
   */
  async listExecutions(): Promise<JobExecution[]> {
    logger.debug(`Listing executions for job: ${this.jobName}`);

    const { data } = await listJobExecutions({
      path: {
        jobId: this.jobName,
      },
      headers: settings.headers,
      throwOnError: true,
    });

    return data ?? [];
  }

  /**
   * Get the status of a specific execution
   */
  async getExecutionStatus(executionId: string): Promise<string> {
    const execution = await this.getExecution(executionId);
    return execution.status ?? "UNKNOWN";
  }

  /**
   * Cancel a specific execution
   */
  async cancelExecution(executionId: string): Promise<void> {
    logger.debug(
      `Cancelling execution ${executionId} for job: ${this.jobName}`,
    );

    await deleteJobExecution({
      path: {
        jobId: this.jobName,
        executionId: executionId,
      },
      headers: settings.headers,
      throwOnError: true,
    });
  }

  /**
   * Wait for an execution to complete
   * @param executionId The execution ID to wait for
   * @param options.maxWait Maximum time to wait in milliseconds (default: 6 minutes)
   * @param options.interval Polling interval in milliseconds (default: 3 seconds)
   */
  async waitForExecution(
    executionId: string,
    options: { maxWait?: number; interval?: number } = {},
  ): Promise<JobExecution> {
    const maxWait = options.maxWait ?? 360000; // 6 minutes default (jobs typically run for 5 minutes)
    const interval = options.interval ?? 3000; // 3 seconds default
    const startTime = Date.now();

    logger.debug(
      `Waiting for execution ${executionId} to complete (max ${maxWait}ms)`,
    );

    while (Date.now() - startTime < maxWait) {
      const execution = await this.getExecution(executionId);
      const status = execution.status;

      // Terminal states
      if (
        status === "COMPLETED" ||
        status === "FAILED" ||
        status === "CANCELLED"
      ) {
        logger.debug(
          `Execution ${executionId} finished with status: ${status}`,
        );
        return execution;
      }

      // Wait before polling again
      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    throw new Error(
      `Execution ${executionId} did not complete within ${maxWait}ms`,
    );
  }
}

export const blJob = (jobName: string) => {
  return new BlJob(jobName);
};
