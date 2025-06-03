import { getForcedUrl, getGlobalUniqueHash } from "../common/internal.js";
import { logger } from "../common/logger.js";
import { settings } from "../common/settings.js";
import { startSpan } from '../telemetry/telemetry.js';

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
      `${settings.runUrl}/${settings.workspace}/jobs/${this.jobName}`
    );
  }

  get internalUrl() {
    const hash = getGlobalUniqueHash(
      settings.workspace,
      "job",
      this.jobName
    );
    return new URL(
      `${settings.runInternalProtocol}://bl-${settings.env}-${hash}.${settings.runInternalHostname}`
    );
  }

  get forcedUrl() {
    return getForcedUrl('job', this.jobName)
  }

  get url() {
    if (this.forcedUrl) return this.forcedUrl;
    if (settings.runInternalHostname) return this.internalUrl;
    return this.externalUrl;
  }

  async call(
    url: URL,
    tasks: Record<string, unknown>[],
  ): Promise<Response> {
    const body = {
      tasks: tasks
    }
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

  async run(
    tasks: Record<string, unknown>[],
  ): Promise<string> {
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
}

export const blJob = (jobName: string) => {
  return new BlJob(jobName);
};
