import { Sandbox } from "../../client/types.gen.js";
import { settings } from "../../common/settings.js";
import { SandboxAction } from "../action.js";
import { DeleteProcessByIdentifierKillResponse, DeleteProcessByIdentifierResponse, GetProcessByIdentifierResponse, GetProcessResponse, PostProcessResponse, ProcessRequest, deleteProcessByIdentifier, deleteProcessByIdentifierKill, getProcess, getProcessByIdentifier, getProcessByIdentifierLogs, postProcess } from "../client/index.js";
import { ProcessRequestWithLog, ProcessResponseWithLog } from "../types.js";

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
    void (async () => {
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
          const result = await reader.read();
          if (result.done) break;
          if (result.value && result.value instanceof Uint8Array) {
            buffer += decoder.decode(result.value, { stream: true });
          }
          const lines = buffer.split(/\r?\n/);
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
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'name' in err && err.name !== 'AbortError') {
          console.error("Stream error:", err);
          throw new Error(err instanceof Error ? err.message : 'Unknown stream error');
        }
      }
    })();
    return {
      close: () => controller.abort(),
    };
  }

  async exec(
    process: ProcessRequest | ProcessRequestWithLog,
  ): Promise<PostProcessResponse | ProcessResponseWithLog> {
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

    const { response, data, error } = await postProcess({
      body: process,
      baseUrl: this.url,
      client: this.client,
    });
    this.handleResponseError(response, data, error);

    let result = data as PostProcessResponse;

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
          close () {
            if (streamControl) {
              streamControl.close();
            }
          },
        }
      }
    }

    return { ...result, close: () => { } };
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
}

