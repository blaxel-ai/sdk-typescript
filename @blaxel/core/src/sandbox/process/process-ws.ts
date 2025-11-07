import { Sandbox } from "../../client/types.gen.js";
import { SandboxAction } from "../action.js";
import { WebSocketClient } from "../websocket/index.js";
import { SandboxProcess } from "./process.js";
import { ProcessRequest, ProcessResponse, SuccessResponse } from "../client/index.js";
import { ProcessRequestWithLog, ProcessResponseWithLog } from "../types.js";

export class SandboxProcessWebSocket extends SandboxAction {
  private wsClient: WebSocketClient;
  private httpClient: SandboxProcess;

  constructor(sandbox: Sandbox, wsClient: WebSocketClient) {
    super(sandbox);
    this.wsClient = wsClient;
    // Create HTTP client for fallback operations
    this.httpClient = new SandboxProcess(sandbox);
  }

  public streamLogs(
    identifier: string,
    options: {
      onLog?: (log: string) => void;
      onStdout?: (stdout: string) => void;
      onStderr?: (stderr: string) => void;
    }
  ): { close: () => void } {
    const streamId = this.wsClient.sendStream(
      "process:logs:stream:start",
      { identifier },
      (data: any) => {
        // Handle streaming log data
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (data && data.log) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          const log = String(data.log);

          // Parse log format: "stdout:" or "stderr:" prefix
          if (log.startsWith('stdout:')) {
            const stdout = log.slice(7);
            options.onStdout?.(stdout);
            options.onLog?.(stdout);
          } else if (log.startsWith('stderr:')) {
            const stderr = log.slice(7);
            options.onStderr?.(stderr);
            options.onLog?.(stderr);
          } else {
            options.onLog?.(log);
          }
        }
      },
      () => {
        // Stream ended
      }
    );

    return {
      close: () => this.wsClient.cancelStream(streamId),
    };
  }

  async exec(
    process: ProcessRequest | ProcessRequestWithLog,
  ): Promise<ProcessResponse | ProcessResponseWithLog> {
    let onLog: ((log: string) => void) | undefined;
    if ('onLog' in process && process.onLog) {
      onLog = process.onLog;
      delete process.onLog;
    }

    // Store original wait_for_completion setting
    const shouldWaitForCompletion = process.waitForCompletion;

    // Always start process without wait_for_completion to avoid server-side blocking
    if (shouldWaitForCompletion && onLog) {
      process.waitForCompletion = false;
    }

    const data = await this.wsClient.send<ProcessResponse>("process:execute", process);

    let result = data;

    // Handle wait_for_completion with parallel log streaming
    if (shouldWaitForCompletion && onLog) {
      const streamControl = this.streamLogs(result.pid, { onLog });
      try {
        // Wait for process completion
        result = await this.wait(result.pid, { interval: 500, maxWait: 1000 * 60 * 60 });
      } finally {
        // Clean up log streaming
        if (streamControl) {
          streamControl.close();
        }
      }
    } else {
      // For non-blocking execution, set up log streaming immediately if requested
      if (onLog) {
        const streamControl = this.streamLogs(result.pid, { onLog });
        return {
          ...result,
          close() {
            if (streamControl) {
              streamControl.close();
            }
          },
        };
      }
    }

    return { ...result, close: () => { } };
  }

  async wait(
    identifier: string,
    { maxWait = 60000, interval = 1000 }: { maxWait?: number; interval?: number } = {}
  ): Promise<ProcessResponse> {
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

  async get(identifier: string): Promise<ProcessResponse> {
    const data = await this.wsClient.send<ProcessResponse>("process:get", { identifier });
    return data;
  }

  async list(): Promise<ProcessResponse[]> {
    const data = await this.wsClient.send<ProcessResponse[]>("process:list", {});
    return data;
  }

  async stop(identifier: string): Promise<SuccessResponse> {
    const data = await this.wsClient.send<SuccessResponse>("process:stop", { identifier });
    return data;
  }

  async kill(identifier: string): Promise<SuccessResponse> {
    const data = await this.wsClient.send<SuccessResponse>("process:kill", { identifier });
    return data;
  }

  async logs(identifier: string, type: "stdout" | "stderr" | "all" = "all"): Promise<string> {
    const data = await this.wsClient.send<{ logs?: string; stdout?: string; stderr?: string }>("process:logs", {
      identifier,
    });

    if (type === "all") {
      return data.logs || "";
    } else if (type === "stdout") {
      return data.stdout || "";
    } else if (type === "stderr") {
      return data.stderr || "";
    }
    throw new Error("Unsupported log type");
  }
}

