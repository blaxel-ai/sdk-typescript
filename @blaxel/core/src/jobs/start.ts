import { authenticate } from '../common/autoload.js';
import { env } from '../common/env.js';
import { flush } from '../telemetry/telemetry.js';
import { ExecutionArgs } from './types.js';
class BlJobWrapper {
  private async fetchWithRetry(url: string, maxRetries = 3): Promise<Response> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url);

        // If the response is successful, return it
        if (response.ok) {
          return response;
        }

        // If it's not the last attempt and the status is retriable, retry
        if (attempt < maxRetries && (response.status >= 500 || response.status === 429)) {
          lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
        } else {
          // For non-retriable errors or last attempt, return the response
          return response;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // If this is the last attempt, throw the error
        if (attempt === maxRetries) {
          throw lastError;
        }
      }

      // Calculate exponential backoff delay: 2^attempt * 1000ms (1s, 2s, 4s)
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    throw lastError || new Error('Failed to fetch after retries');
  }

  async getArguments() {
    if(!env.BL_EXECUTION_DATA_URL) {
      const args = this.parseCommandLineArgs()
      return args
    }

    const response = await this.fetchWithRetry(env.BL_EXECUTION_DATA_URL);
    const data = await response.json() as {tasks: ExecutionArgs};
    return data.tasks[this.index] ?? {};
  }

  private parseCommandLineArgs(): Record<string, string> {
    const args = process.argv.slice(2);
    const result: Record<string, string> = {};

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg.startsWith('--')) {
        const key = arg.slice(2);
        const value = args[i + 1];
        if (value && !value.startsWith('--')) {
          result[key] = value;
          i++;
        } else {
          result[key] = 'true';
        }
      }
    }

    return result;
  }

  get indexKey(): string {
    return env.BL_TASK_KEY ?? "TASK_INDEX";
  }

  get index(): number {
    return env[this.indexKey] ? Number(env[this.indexKey]) : 0;
  }

  /*
    Run a job defined in a function, it's run in the current process
  */
  async start(func: (args: any) => Promise<void>) {
    await authenticate();
    const parsedArgs = await this.getArguments();
    await func(parsedArgs);
  }
}

export const blStartJob = (func: (args: any) => Promise<void>) => {
  const job = new BlJobWrapper();
  job.start(func).then(async () => {
    try {
      await flush()
    } catch (error) {
      console.error('Error flushing telemetry:', error);
    }
    process.exit(0);
  }).catch((error) => {
    console.error('Job execution failed:', error);
    process.exit(1);
  });
}
