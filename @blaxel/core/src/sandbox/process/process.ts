import { v4 as uuidv4 } from "uuid";
import { observeProcess, ProcessExecutionError, type ProcessWaitOptions } from "./state.js";
import { Sandbox } from "../../client/types.gen.js";
import { SandboxAction } from "../action.js";
import { retryOnTransientReset } from "../../common/transient-retry.js";
import { DeleteProcessByIdentifierKillResponse, DeleteProcessByIdentifierResponse, GetProcessByIdentifierResponse, GetProcessResponse, PostProcessResponse, ProcessRequest, deleteProcessByIdentifier, deleteProcessByIdentifierKill, deleteProcessByIdentifierStdin, getProcess, getProcessByIdentifier, getProcessByIdentifierLogs, getProcessByIdentifierLogsStream, postProcess, postProcessByIdentifierStdin } from "../client/index.js";
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
  ): { close: () => void, wait: () => Promise<void> } {
    const controller = new AbortController();
    const handleError = (err: Error) => {
      if (options.onError) {
        options.onError(err);
      }
      throw err;
    };

    const processLine = (line: string) => {
      if (line.startsWith("[keepalive]")) {
        return;
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
    };

    const done = (async () => {
      let buffer = '';
      try {
        const { response: stream, data, error } = await getProcessByIdentifierLogsStream(this.withClient({
          path: { identifier },
          baseUrl: this.url,
          signal: controller.signal,
          parseAs: "stream",
        }));
        this.handleResponseError(stream, data, error);
        if (!stream.body) {
          throw new Error('No stream body');
        }

        const reader = stream.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          if (result.value && result.value instanceof Uint8Array) {
            buffer += decoder.decode(result.value, { stream: true });
          }
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop()!;
          for (const line of lines) {
            processLine(line);
          }
        }
        // Flush the TextDecoder and process any remaining buffered data
        buffer += decoder.decode();
        if (buffer.trim()) {
          processLine(buffer);
        }
      } catch (err: unknown) {
        if (controller.signal.aborted) {
          // Process remaining buffer before returning on abort
          if (buffer.trim()) {
            processLine(buffer);
          }
          return;
        }
        handleError(err instanceof Error ? err : new Error('Unknown stream error'));
      }
    })();

    // Callback-only users need not await wait(); preserve rejection for those who do.
    void done.catch(() => {});
    return {
      close: () => controller.abort(),
      wait: () => done,
    };
  }

  async exec(
    process: ProcessRequest | ProcessRequestWithLog,
  ): Promise<PostProcessResponse | ProcessResponseWithLog> {
    const { onLog, onStdout, onStderr, ...request } = process as ProcessRequestWithLog;
    // Known before POST, even if the response is lost. Do not mutate caller input.
    process = { ...request, name: request.name || `proc-${uuidv4()}` };
    try {
      // Store original wait_for_completion setting
      const shouldWaitForCompletion = process.waitForCompletion;

      // When waiting for completion with streaming callbacks, use streaming endpoint
      if (shouldWaitForCompletion && (onLog || onStdout || onStderr)) {
        return await this.execWithStreaming(process, { onLog, onStdout, onStderr });
      } else {
        const { response, data, error } = await postProcess(this.withClient({
          body: process,
          baseUrl: this.url,
        }));
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
    } catch (error) {
      throw new ProcessExecutionError(process.name!, error);
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
    const controller = new AbortController();
    const { response, data, error } = await postProcess(this.withClient({
      baseUrl: this.url,
      signal: controller.signal,
      headers: { Accept: "text/event-stream" },
      body: processRequest,
      parseAs: "stream",
    }));
    this.handleResponseError(response, data, error);

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

    // Flush the TextDecoder and process any remaining buffered data
    buffer += decoder.decode();
    if (buffer.trim()) {
      let parsed: { type: string, data: string } | null = null;
      try {
        parsed = JSON.parse(buffer.trim()) as { type: string, data: string };
      } catch (e) {
        // Not valid JSON — try legacy result: prefix format
        if (buffer.startsWith('result:')) {
          const jsonStr = buffer.slice(7);
          try {
            result = JSON.parse(jsonStr) as PostProcessResponse;
          } catch {
            throw new Error(`Failed to parse result JSON: ${jsonStr}`);
          }
        } else {
          // Not a legacy result line — surface the original parse error
          throw e;
        }
      }
      if (parsed) {
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

  /** Observe the original command. Cancelling this wait never stops the command. */
  async wait(identifier: string, options: ProcessWaitOptions = {}): Promise<GetProcessByIdentifierResponse> {
    return observeProcess(identifier, signal => this.get(identifier, { signal, retry: false }), options);
  }

  async get(identifier: string, { signal, retry = true }: { signal?: AbortSignal; retry?: boolean } = {}): Promise<GetProcessByIdentifierResponse> {
    const read = async () => {
      const { response, data, error } = await getProcessByIdentifier(this.withClient({
        path: { identifier },
        baseUrl: this.url,
        signal,
      }));
      this.handleResponseError(response, data, error);
      return data as GetProcessByIdentifierResponse;
    };
    // wait owns its retry/deadline budget; standalone reads retain existing retries.
    return retry ? retryOnTransientReset(read) : read();
  }

  /** Send SIGKILL, then confirm a terminal status reported by the API (not OS reaping). */
  async killAndWait(identifier: string, options: ProcessWaitOptions = {}): Promise<GetProcessByIdentifierResponse> {
    return observeProcess(identifier, signal => this.get(identifier, { signal, retry: false }), options,
      signal => this.kill(identifier, { signal }));
  }

  /** Send SIGTERM, then confirm a terminal status reported by the API (not OS reaping). */
  async stopAndWait(identifier: string, options: ProcessWaitOptions = {}): Promise<GetProcessByIdentifierResponse> {
    return observeProcess(identifier, signal => this.get(identifier, { signal, retry: false }), options,
      signal => this.stop(identifier, { signal }));
  }

  async list(): Promise<GetProcessResponse> {
    // Idempotent GET: self-heal a transient connection reset.
    return retryOnTransientReset(async () => {
      const { response, data, error } = await getProcess(this.withClient({
        baseUrl: this.url,
      }));
      this.handleResponseError(response, data, error);
      return data as GetProcessResponse;
    });
  }

  async stop(identifier: string, { signal }: { signal?: AbortSignal } = {}): Promise<DeleteProcessByIdentifierResponse> {
    const { response, data, error } = await deleteProcessByIdentifier(this.withClient({
      path: { identifier },
      baseUrl: this.url,
      signal,
    }));
    this.handleResponseError(response, data, error);
    return data as DeleteProcessByIdentifierResponse;
  }

  async kill(identifier: string, { signal }: { signal?: AbortSignal } = {}): Promise<DeleteProcessByIdentifierKillResponse> {
    const { response, data, error } = await deleteProcessByIdentifierKill(this.withClient({
      path: { identifier },
      baseUrl: this.url,
      signal,
    }));
    this.handleResponseError(response, data, error);
    return data as DeleteProcessByIdentifierKillResponse;
  }

  /**
   * Write raw bytes to the stdin of a process started with `stdin: true`.
   * Bytes go through verbatim, so include the trailing newline your protocol
   * expects (one JSON-RPC message per call for an MCP stdio server). Not
   * retried: a duplicate write would corrupt the stream.
   */
  async writeStdin(identifier: string, data: string | Uint8Array): Promise<void> {
    const { response, data: result, error } = await postProcessByIdentifierStdin(this.withClient({
      path: { identifier },
      baseUrl: this.url,
      body: data as string,
      // The generated client JSON-encodes bodies by default; stdin is raw.
      bodySerializer: null,
    }));
    this.handleResponseError(response, result, error);
  }

  /**
   * Close the process's stdin (EOF). Idempotent. For stdio protocols such as
   * MCP this is the clean shutdown path.
   */
  async closeStdin(identifier: string): Promise<void> {
    const { response, data, error } = await deleteProcessByIdentifierStdin(this.withClient({
      path: { identifier },
      baseUrl: this.url,
    }));
    this.handleResponseError(response, data, error);
  }

  async logs(identifier: string, type: "stdout" | "stderr" | "all" = "all"): Promise<string> {
    // Idempotent GET: self-heal a transient connection reset.
    const data = await retryOnTransientReset(async () => {
      const { response, data, error } = await getProcessByIdentifierLogs(this.withClient({
        path: { identifier },
        baseUrl: this.url,
      }));
      this.handleResponseError(response, data, error);
      return data;
    });
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
