import { z } from "zod";

export const ExecParamsSchema = z.object({
  process: z.any().describe("ProcessRequest object to execute in the sandbox"), // Refine if you have a zod schema for ProcessRequest
}).describe("Parameters for executing a process in the sandbox");

export const WaitParamsSchema = z.object({
  identifier: z.string().describe("Process identifier to wait for"),
  maxWait: z.number().optional().default(60000).describe("Maximum wait time in milliseconds (default 60000)"),
  interval: z.number().optional().default(1000).describe("Polling interval in milliseconds (default 1000)"),
}).describe("Parameters for waiting for a process to finish");

export const GetParamsSchema = z.object({
  identifier: z.string().describe("Process identifier to get info for"),
}).describe("Parameters for getting process info");

export const ListParamsSchema = z.object({}).describe("Parameters for listing all processes (none)");

export const StopParamsSchema = z.object({
  identifier: z.string().describe("Process identifier to stop"),
}).describe("Parameters for stopping a process");

export const KillParamsSchema = z.object({
  identifier: z.string().describe("Process identifier to kill"),
}).describe("Parameters for killing a process");

export const LogsParamsSchema = z.object({
  identifier: z.string().describe("Process identifier to get logs for"),
  type: z.enum(["stdout", "stderr", "all"]).optional().default("all").describe("Type of logs to retrieve: stdout, stderr, or all (default all)"),
}).describe("Parameters for retrieving process logs");

export type ProcessToolWithoutExecute = {
  exec: {
    description: string;
    parameters: typeof ExecParamsSchema;
  };
  wait: {
    description: string;
    parameters: typeof WaitParamsSchema;
  };
  get: {
    description: string;
    parameters: typeof GetParamsSchema;
  };
  list: {
    description: string;
    parameters: typeof ListParamsSchema;
  };
  stop: {
    description: string;
    parameters: typeof StopParamsSchema;
  };
  kill: {
    description: string;
    parameters: typeof KillParamsSchema;
  };
  logs: {
    description: string;
    parameters: typeof LogsParamsSchema;
  };
};

export type ProcessToolWithExecute = {
  exec: {
    description: string;
    parameters: typeof ExecParamsSchema;
    execute: (args: z.infer<typeof ExecParamsSchema>) => Promise<string>;
  };
  wait: {
    description: string;
    parameters: typeof WaitParamsSchema;
    execute: (args: z.infer<typeof WaitParamsSchema>) => Promise<string>;
  };
  get: {
    description: string;
    parameters: typeof GetParamsSchema;
    execute: (args: z.infer<typeof GetParamsSchema>) => Promise<string>;
  };
  list: {
    description: string;
    parameters: typeof ListParamsSchema;
    execute: (args: z.infer<typeof ListParamsSchema>) => Promise<string>;
  };
  stop: {
    description: string;
    parameters: typeof StopParamsSchema;
    execute: (args: z.infer<typeof StopParamsSchema>) => Promise<string>;
  };
  kill: {
    description: string;
    parameters: typeof KillParamsSchema;
    execute: (args: z.infer<typeof KillParamsSchema>) => Promise<string>;
  };
  logs: {
    description: string;
    parameters: typeof LogsParamsSchema;
    execute: (args: z.infer<typeof LogsParamsSchema>) => Promise<string>;
  };
};
