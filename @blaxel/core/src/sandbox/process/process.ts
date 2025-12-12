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
      onError?: (error: Error) => void,
    } = {}
  ): { close: () => void } {
    const controller = new AbortController();
    const handleError = (err: Error) => {
      if (options.onError) {
        options.onError(err);
      } else {
        console.error("Stream error:", err);
      }
    };

    void (async () => {
      try {
        const headers = this.sandbox.forceUrl ? this.sandbox.headers : settings.headers;
        const stream = await fetch(`${this.url}/process/${identifier}/logs/stream`, {
          method: 'GET',
          signal: controller.signal,
          headers,
        });

        if (stream.status !== 200) {
          handleError(new Error(`Failed to stream logs: ${await stream.text()}`));
          return;
        }
        if (!stream.body) {
          handleError(new Error('No stream body'));
          return;
        }

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
            if (line.startsWith("[keepalive]")) {
              continue;
            }
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
        if (err && typeof err === 'object' && 'name' in err && err.name === 'AbortError') {
          return;
        }
        handleError(err instanceof Error ? err : new Error('Unknown stream error'));
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
    let onStdout: ((stdout: string) => void) | undefined;
    let onStderr: ((stderr: string) => void) | undefined;
    if ('onLog' in process && process.onLog) {
      onLog = process.onLog;
      delete process.onLog;
    }
    if ('onStdout' in process && process.onStdout) {
      onStdout = process.onStdout;
      delete process.onStdout;
    }
    if ('onStderr' in process && process.onStderr) {
      onStderr = process.onStderr;
      delete process.onStderr;
    }

    // Store original wait_for_completion setting
    const shouldWaitForCompletion = process.waitForCompletion;

    // When waiting for completion with streaming callbacks, use streaming endpoint
    if (shouldWaitForCompletion && (onLog || onStdout || onStderr)) {
      return await this.execWithStreaming(process, { onLog, onStdout, onStderr });
    } else {
      const { response, data, error } = await postProcess({
        body: process,
        baseUrl: this.url,
        client: this.client,
      });
      this.handleResponseError(response, data, error);
      const result = data as PostProcessResponse;
      if (onLog || onStdout || onStderr) {
        const streamControl = this.streamLogs(result.pid, { onLog, onStdout, onStderr });
        return {
          ...result,
          close() {
            if (streamControl) {
              streamControl.close();
            }
          },
        }
      }
      return result;
    }
  }

  private async execWithStreaming(
    processRequest: ProcessRequest,
    options: {
      onLog?: (log: string) => void;
      onStdout?: (stdout: string) => void;
      onStderr?: (stderr: string) => void;
    }
  ): Promise<ProcessResponseWithLog> {
    const headers = this.sandbox.forceUrl ? this.sandbox.headers : settings.headers;
    const controller = new AbortController();

    const response = await fetch(`${this.url}/process`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(processRequest),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to execute process: ${errorText}`);
    }

    const contentType = response.headers.get('Content-Type') || '';
    const isStreaming = contentType.includes('application/x-ndjson');

    // Fallback: server doesn't support streaming, use legacy approach
    if (!isStreaming) {
      const data = await response.json() as PostProcessResponse;
      // If process already completed (server waited), just return with logs
      if (data.status === 'completed' || data.status === 'failed') {
        // Emit any captured logs through callbacks
        if (data.stdout) {
          for (const line of data.stdout.split('\n').filter(l => l)) {
            options.onStdout?.(line);
          }
        }
        if (data.stderr) {
          for (const line of data.stderr.split('\n').filter(l => l)) {
            options.onStderr?.(line);
          }
        }
        if (data.logs) {
          for (const line of data.logs.split('\n').filter(l => l)) {
            options.onLog?.(line);
          }
        }
        return {
          ...data,
          close: () => {},
        };
      }
      return {
        ...data,
        close: () => {},
      };
    }

    // Streaming response handling
    if (!response.body) {
      throw new Error('No response body for streaming');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result: PostProcessResponse | null = null;

    while (true) {
      const readResult = await reader.read();
      if (readResult.done) break;

      if (readResult.value && readResult.value instanceof Uint8Array) {
        buffer += decoder.decode(readResult.value, { stream: true });
      }

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop()!;

      for (const line of lines) {
        const parsed = JSON.parse(line) as { type: string, data: string };
        switch (parsed.type) {
          case 'stdout':
            if (parsed.data) {
              options.onStdout?.(parsed.data);
              options.onLog?.(parsed.data);
            }
            break;
          case 'stderr':
            if (parsed.data) {
              options.onStderr?.(parsed.data);
              options.onLog?.(parsed.data);
            }
            break;
          case 'result':
            try {
              result = JSON.parse(parsed.data) as PostProcessResponse;
            } catch {
              throw new Error(`Failed to parse result JSON: ${parsed.data}`);
            }
            break;
          default:
            break;
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      if (buffer.startsWith('result:')) {
        const jsonStr = buffer.slice(7);
        try {
          result = JSON.parse(jsonStr) as PostProcessResponse;
        } catch {
          throw new Error(`Failed to parse result JSON: ${jsonStr}`);
        }
      }
    }

    if (!result) {
      throw new Error('No result received from streaming response');
    }

    return {
      ...result,
      close: () => controller.abort(),
    };
  }

  async wait(identifier: string, { maxWait = 60000, interval = 1000 }: { maxWait?: number, interval?: number } = {}): Promise<GetProcessByIdentifierResponse> {
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

