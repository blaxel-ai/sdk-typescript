import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { env } from '../common/env.js';

type BatchArgs = {
  [key: number]: any;
}[];

class BlJob {
  async getArguments() {
    if(!env.BL_BATCH_DATA_URL) {
      const argv = await yargs(hideBin(process.argv))
        .parseAsync();
      return argv;
    }

    const response = await fetch(env.BL_BATCH_DATA_URL);
    const data = await response.json() as {tasks: BatchArgs};
    return data.tasks[this.index] ?? {};
  }

  get indexKey(): string {
    return env.BL_BATCH_INDEX_KEY ?? "TASK_INDEX";
  }

  get index(): number {
    return env[this.indexKey] ? Number(env[this.indexKey]) ?? 0 : 0;
  }

  /*
    Run a job defined in a function, it's run in the current process
  */
  async start(func: (args: any) => Promise<void>) {
    try {
      const parsedArgs = await this.getArguments();
      await func(parsedArgs);
      process.exit(0);
    } catch (error) {
      console.error('Job execution failed:', error);
      process.exit(1);
    }
  }
}
export const blJob = new BlJob();