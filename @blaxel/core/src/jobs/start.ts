import { env } from '../common/env.js';
import { startSpan } from '../telemetry/telemetry.js';
import { ExecutionArgs } from './types.js';
class BlJobWrapper {
  async getArguments() {
    if(!env.BL_EXECUTION_DATA_URL) {
      const args = this.parseCommandLineArgs()
      return args
    }

    const response = await fetch(env.BL_EXECUTION_DATA_URL);
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
    return env[this.indexKey] ? Number(env[this.indexKey]) ?? 0 : 0;
  }

  /*
    Run a job defined in a function, it's run in the current process
  */
  async start(func: (args: any) => Promise<void>) {
    let span = startSpan(`blStartJob-${func.name}`, {
      attributes: {
        'job.name': func.name,
        'job.index': this.index,
        'job.args': JSON.stringify(this.getArguments()),
      }
    })
    try {
      const parsedArgs = await this.getArguments();
      await func(parsedArgs);
      span.setStatus('ok');
      process.exit(0);
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus('error', 'Job execution failed');
      console.error('Job execution failed:', error);
      process.exit(1);
    } finally {
      span.end();
    }
  }
}

export const blStartJob = (func: (args: any) => Promise<void>) => {
  const job = new BlJobWrapper();
  job.start(func);
}