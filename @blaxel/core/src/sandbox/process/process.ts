import { Sandbox } from "../../client/types.gen.js";
import { settings } from "../../common/settings.js";
import { SandboxAction } from "../action.js";
import { DeleteProcessByIdentifierKillResponse, DeleteProcessByIdentifierResponse, GetProcessByIdentifierResponse, GetProcessResponse, PostProcessResponse, ProcessRequest, deleteProcessByIdentifier, deleteProcessByIdentifierKill, getProcess, getProcessByIdentifier, getProcessByIdentifierLogs, postProcess } from "../client/index.js";
import { ExecParamsSchema, GetParamsSchema, KillParamsSchema, ListParamsSchema, LogsParamsSchema, ProcessToolWithExecute, ProcessToolWithoutExecute, StopParamsSchema, WaitParamsSchema } from "./types.js";

export class SandboxProcess extends SandboxAction {
  constructor(sandbox: Sandbox) {
    super(sandbox);
  }

  public streamLogs(
    identifier: string,
    options: {
      onLog?: (log: string) => void,
      onStdout?: (stdout: string) => void,
      onStderr?: (stderr: string) => void,
    }
  ): { close: () => void } {
    const controller = new AbortController();
    (async () => {
      try {
        const headers = this.sandbox.forceUrl ? this.sandbox.headers : settings.headers;
        const stream = await fetch(`${this.url}/process/${identifier}/logs/stream`, {
          method: 'GET',
          signal: controller.signal,
          headers,
        });

        if (stream.status !== 200) {
          throw new Error(`Failed to stream logs: ${await stream.text()}`);
        }
        if (!stream.body) throw new Error('No stream body');

        const reader = stream.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let lines = buffer.split(/\r?\n/);
          buffer = lines.pop()!;
          for (const line of lines) {
            if (line.startsWith('stdout:')) {
              options.onStdout?.(line.slice(7));
              options.onLog?.(line.slice(7));
            } else if (line.startsWith('stderr:')) {
              options.onStderr?.(line.slice(7));
              options.onLog?.(line.slice(7));
            } else {
              options.onLog?.(line);
            }
          }
        }
      } catch (err: any) {
        if (err && err.name !== 'AbortError') {
          console.error("Stream error:", err);
          throw err;
        }
      }
    })();
    return {
      close: () => controller.abort(),
    };
  }

  async exec(process: ProcessRequest): Promise<PostProcessResponse> {
    const { response, data, error } = await postProcess({
      body: process,
      baseUrl: this.url,
      client: this.client,
    });
    this.handleResponseError(response, data, error);
    return data as PostProcessResponse;
  }

  async wait(identifier: string, {maxWait = 60000, interval = 1000}: {maxWait?: number, interval?: number} = {}): Promise<GetProcessByIdentifierResponse> {
    const startTime = Date.now();
    let status = "running";
    let data = await this.get(identifier);
    while (status === "running") {
      await new Promise((resolve) => setTimeout(resolve, interval));
      try {
        data = await this.get(identifier);
        status = data.status ?? "running";
      } catch {
        break;
      }
      if (Date.now() - startTime > maxWait) {
        throw new Error("Process did not finish in time");
      }
    }
    return data;
  }

  async get(identifier: string): Promise<GetProcessByIdentifierResponse> {
    const { response, data, error } = await getProcessByIdentifier({
      path: { identifier },
      baseUrl: this.url,
      client: this.client,
    });
    this.handleResponseError(response, data, error);
    return data as GetProcessByIdentifierResponse;
  }

  async list(): Promise<GetProcessResponse> {
    const { response, data, error } = await getProcess({
      baseUrl: this.url,
      client: this.client,
    });
    this.handleResponseError(response, data, error);
    return data as GetProcessResponse;
  }

  async stop(identifier: string): Promise<DeleteProcessByIdentifierResponse> {
    const { response, data, error } = await deleteProcessByIdentifier({
      path: { identifier },
      baseUrl: this.url,
      client: this.client,
    });
    this.handleResponseError(response, data, error);
    return data as DeleteProcessByIdentifierResponse;
  }

  async kill(identifier: string): Promise<DeleteProcessByIdentifierKillResponse> {
    const { response, data, error } = await deleteProcessByIdentifierKill({
      path: { identifier },
      baseUrl: this.url,
      client: this.client,
    });
    this.handleResponseError(response, data, error);
    return data as DeleteProcessByIdentifierKillResponse;
  }

  async logs(identifier: string, type: "stdout" | "stderr" | "all" = "all"): Promise<string> {
    const { response, data, error } = await getProcessByIdentifierLogs({
      path: { identifier },
      baseUrl: this.url,
      client: this.client,
    });
    this.handleResponseError(response, data, error);
    if (type === "all") {
      return data?.logs || "";
    } else if (type === "stdout") {
      return data?.stdout || "";
    } else if (type === "stderr") {
      return data?.stderr || "";
    }
    throw new Error("Unsupported log type");
  }

  get toolsWithoutExecute(): ProcessToolWithoutExecute {
    return {
      exec: {
        description: "Execute a process in the sandbox",
        parameters: ExecParamsSchema,
      },
      wait: {
        description: "Wait for a process to finish by identifier",
        parameters: WaitParamsSchema,
      },
      get: {
        description: "Get process info by identifier",
        parameters: GetParamsSchema,
      },
      list: {
        description: "List all processes in the sandbox",
        parameters: ListParamsSchema,
      },
      stop: {
        description: "Stop a process by identifier",
        parameters: StopParamsSchema,
      },
      kill: {
        description: "Kill a process by identifier",
        parameters: KillParamsSchema,
      },
      logs: {
        description: "Get logs for a process by identifier",
        parameters: LogsParamsSchema,
      },
    };
  }

  get tools(): ProcessToolWithExecute {
    return {
      exec: {
        description: "Execute a process in the sandbox",
        parameters: ExecParamsSchema,
        execute: async (args) => {
          try {
            const result = await this.exec(args.process);
            return JSON.stringify(result);
          } catch (e: any) {
            return JSON.stringify({ message: e.message, process: args.process });
          }
        },
      },
      wait: {
        description: "Wait for a process to finish by identifier",
        parameters: WaitParamsSchema,
        execute: async (args) => {
          try {
            const result = await this.wait(args.identifier, { maxWait: args.maxWait, interval: args.interval });
            return JSON.stringify(result);
          } catch (e: any) {
            return JSON.stringify({ message: e.message, identifier: args.identifier });
          }
        },
      },
      get: {
        description: "Get process info by identifier",
        parameters: GetParamsSchema,
        execute: async (args) => {
          try {
            const result = await this.get(args.identifier);
            return JSON.stringify(result);
          } catch (e: any) {
            return JSON.stringify({ message: e.message, identifier: args.identifier });
          }
        },
      },
      list: {
        description: "List all processes in the sandbox",
        parameters: ListParamsSchema,
        execute: async () => {
          try {
            const result = await this.list();
            return JSON.stringify(result);
          } catch (e: any) {
            return JSON.stringify({ message: e.message });
          }
        },
      },
      stop: {
        description: "Stop a process by identifier",
        parameters: StopParamsSchema,
        execute: async (args) => {
          try {
            const result = await this.stop(args.identifier);
            return JSON.stringify(result);
          } catch (e: any) {
            return JSON.stringify({ message: e.message, identifier: args.identifier });
          }
        },
      },
      kill: {
        description: "Kill a process by identifier",
        parameters: KillParamsSchema,
        execute: async (args) => {
          try {
            const result = await this.kill(args.identifier);
            return JSON.stringify(result);
          } catch (e: any) {
            return JSON.stringify({ message: e.message, identifier: args.identifier });
          }
        },
      },
      logs: {
        description: "Get logs for a process by identifier",
        parameters: LogsParamsSchema,
        execute: async (args) => {
          try {
            const result = await this.logs(args.identifier, args.type || "all");
            return JSON.stringify({ logs: result });
          } catch (e: any) {
            return JSON.stringify({ message: e.message, identifier: args.identifier });
          }
        },
      },
    };
  }
}

