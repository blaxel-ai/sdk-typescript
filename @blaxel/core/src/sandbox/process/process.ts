import { Sandbox } from "../../client/types.gen.js";
import { ResponseError, SandboxAction } from "../action.js";
import { isRetryableGatewayError, isTransientResetError, retryOnTransientReset } from "../../common/transient-retry.js";
import { DeleteProcessByIdentifierKillResponse, DeleteProcessByIdentifierResponse, GetProcessByIdentifierResponse, GetProcessResponse, PostProcessResponse, ProcessRequest, deleteProcessByIdentifier, deleteProcessByIdentifierKill, deleteProcessByIdentifierStdin, getProcess, getProcessByIdentifier, getProcessByIdentifierLogs, getProcessByIdentifierLogsStream, postProcess, postProcessByIdentifierStdin } from "../client/index.js";
import { ProcessRequestWithLog, ProcessResponseWithLog } from "../types.js";

// Server-side hold per long-poll: just under the gateway's 120s cut on held requests.
const PROCESS_WAIT_MAX_SECONDS = 119;
// Client-side slack on top of the hold before a wait request counts as stalled.
const PROCESS_WAIT_GRACE_SECONDS = 10;
const waitSeconds = (remainingMs: number) => Math.max(1, Math.ceil(Math.min(PROCESS_WAIT_MAX_SECONDS, remainingMs / 1000)));

/**
 * Run and manage processes in a sandbox. Reach it through `sandbox.process`.
 *
 * Commands run through a shell (`sh -c` unless the image sets `SHELL`), so
 * pipes, `&&` and `cd` work. A process is addressed by its `pid` or by the
 * `name` you give it. Its output is kept after it ends, so `logs()` and
 * `get()` work on finished processes too.
 *
 * Three ways to run a command:
 * - `exec({ command, waitForCompletion: true })` returns once the command
 *   ends, with `exitCode`, `stdout`, `stderr` and `logs`. The request stays
 *   open meanwhile, and the edge in front of the sandbox closes it after 120
 *   seconds with a `SandboxGatewayError` (HTTP 504) while the command keeps
 *   running. Use it for short commands.
 * - `exec({ command, waitForCompletion: true, onLog })` also waits, but
 *   streams the output to the callbacks as it arrives, with keepalives that
 *   hold the connection open. Use it for long commands.
 * - `exec({ command })` returns as soon as the process starts. Follow it
 *   with `wait()`, `streamLogs()`, `get()` and `logs()`. Use it for servers
 *   and background jobs.
 *
 * A command that exits non-zero does not throw: check `status` (`"failed"`)
 * and `exitCode`.
 *
 * @example
 * ```typescript
 * const result = await sandbox.process.exec({
 *   command: "npm test",
 *   workingDir: "/app",
 *   waitForCompletion: true,
 *   onLog: (line) => console.log(line),
 * });
 * if (result.exitCode !== 0) throw new Error(result.stderr);
 * ```
 */
export class SandboxProcess extends SandboxAction {
  constructor(sandbox: Sandbox) {
    super(sandbox);
  }

  /**
   * Stream the output of a process to callbacks: the output so far first,
   * then new output until the process ends.
   *
   * @param identifier - The process `pid` or `name`.
   * @param options - `onLog` gets every chunk, `onStdout` and `onStderr` only their stream; `onError` gets a stream failure.
   * @returns `close()` to stop streaming (the process keeps running) and `wait()`, which resolves when the process ends or `close()` is called.
   *
   * @example
   * ```typescript
   * await sandbox.process.exec({ command: "npm run dev", name: "dev" });
   * const stream = sandbox.process.streamLogs("dev", { onLog: (line) => console.log(line) });
   * // later
   * stream.close();
   * ```
   */
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

    // No callback after close(), even for a chunk already read or buffered, or
    // when an earlier callback for the same line called close().
    const emit = (cb: ((data: string) => void) | undefined, data: string) => {
      if (!controller.signal.aborted) cb?.(data);
    };
    const processLine = (line: string) => {
      if (line.startsWith("[keepalive]")) {
        return;
      }
      if (line.startsWith('stdout:')) {
        emit(options.onStdout, line.slice(7));
        emit(options.onLog, line.slice(7));
      } else if (line.startsWith('stderr:')) {
        emit(options.onStderr, line.slice(7));
        emit(options.onLog, line.slice(7));
      } else {
        emit(options.onLog, line);
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
        if (controller.signal.aborted) return;
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

  /**
   * Start a command in the sandbox. See the class description for when to wait,
   * stream or return right away.
   *
   * @param process - The process to start:
   * - `command`: shell command.
   * - `name`: identifier to use instead of the `pid`. Starting a process with
   *   the name of one still running is rejected with HTTP 400.
   * - `workingDir`: directory to run in. Defaults to the sandbox API's working directory.
   * - `env`: extra environment variables, as a `{ NAME: "value" }` map.
   * - `waitForCompletion`: return only when the command ends. Defaults to false.
   * - `waitForPorts`: return once the process listens on all these ports
   *   (for servers); fails early if the process exits with an error first.
   * - `timeout`: seconds before the process is killed. Defaults to 0 (no
   *   limit), or 600 when `keepAlive` is set.
   * - `keepAlive`: keep the sandbox from scaling to zero while the process runs.
   * - `restartOnFailure` and `maxRestarts`: restart on a non-zero exit, up to
   *   `maxRestarts` times (negative for no limit).
   * - `stdin`: open a stdin pipe for `writeStdin()` and `closeStdin()`.
   * - `onLog`, `onStdout`, `onStderr`: output callbacks. With
   *   `waitForCompletion` the output streams over the same request; without
   *   it the SDK follows the logs with `streamLogs()`.
   * @returns The process: `pid`, `name`, `status` (`"running"`, `"completed"`,
   * `"failed"`, `"killed"` or `"stopped"`), `exitCode`, `stdout`, `stderr`, `logs`
   * and timestamps. With callbacks it also has `close()`, which stops the
   * callbacks without stopping the process.
   * @throws ResponseError on HTTP 400 (invalid request or name in use), and
   * `SandboxGatewayError` when a non-streamed wait outlasts the edge timeout of 120 seconds.
   *
   * @example
   * ```typescript
   * // Short command: wait for the result.
   * const { exitCode, stdout } = await sandbox.process.exec({
   *   command: "ls -la /app",
   *   waitForCompletion: true,
   * });
   *
   * // Server: start it, wait for its port, then read its logs later.
   * await sandbox.process.exec({
   *   command: "npm run dev",
   *   name: "dev",
   *   workingDir: "/app",
   *   waitForPorts: [3000],
   * });
   * const logs = await sandbox.process.logs("dev");
   * ```
   */
  async exec(
    process: ProcessRequest | ProcessRequestWithLog,
  ): Promise<PostProcessResponse | ProcessResponseWithLog> {
    const { onLog, onStdout, onStderr, ...request } = process as ProcessRequestWithLog;
    process = request;

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

  /**
   * Wait until a process ends (`completed`, `failed`, `killed` or
   * `stopped`). The sandbox holds each wait request until the process ends,
   * for up to 119 seconds; sandboxes without that wait endpoint are polled
   * every `interval` instead. A timeout or cancellation never stops the
   * command; call `stop()` or `kill()` for that. Transient network and gateway
   * errors are retried until the deadline.
   *
   * @param identifier - The process `pid` or `name`.
   * @param options - `maxWait`: milliseconds to wait, default 60000, `-1` for
   * no limit; `interval`: milliseconds between requests, default 1000;
   * `signal`: an AbortSignal to cancel the wait.
   * @returns The ended process with its `status`, `exitCode` and output.
   * @throws When `maxWait` runs out ("Process did not finish in time"), or with the signal's reason when aborted.
   *
   * @example
   * ```typescript
   * const { pid } = await sandbox.process.exec({ command: "make build" });
   * const done = await sandbox.process.wait(pid, { maxWait: 10 * 60_000 });
   * ```
   */
  async wait(identifier: string, { maxWait = 60000, interval = 1000, signal }: {
    maxWait?: number; interval?: number; signal?: AbortSignal;
  } = {}): Promise<GetProcessByIdentifierResponse> {
    if (!Number.isFinite(maxWait) || (maxWait < 0 && maxWait !== -1) || !Number.isFinite(interval) || interval <= 0) {
      throw new RangeError("maxWait must be -1 or finite and non-negative; interval must be finite and positive");
    }
    signal?.throwIfAborted();
    const controller = new AbortController();
    let lastError: unknown;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => controller.abort(signal?.reason);
    const timeoutError = () => new Error(`Process did not finish in time (${identifier}); it may still be running`, { cause: lastError });
    if (maxWait === 0) throw timeoutError();
    const deadline = maxWait === -1 ? Infinity : performance.now() + maxWait;
    const timeout = maxWait === -1 ? undefined : setTimeout(() => controller.abort(timeoutError()), maxWait);
    signal?.addEventListener("abort", cancel, { once: true });
    const interrupted = new Promise<never>((_, reject) => {
      // Preserve the caller's AbortSignal reason, which need not be an Error.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    let longPoll = true;
    const poll = async () => {
      while (true) {
        if (performance.now() >= deadline) controller.abort(timeoutError());
        controller.signal.throwIfAborted();
        try {
          let result = longPoll ? await this.waitOnce(identifier, waitSeconds(deadline - performance.now()), controller.signal) : undefined;
          if (!result) {
            // Sandbox older than the /wait route: poll for the rest of this call.
            longPoll = false;
            result = await this.get(identifier, { signal: controller.signal, retry: false });
          }
          if (performance.now() >= deadline) controller.abort(timeoutError());
          controller.signal.throwIfAborted();
          if (["completed", "failed", "killed", "stopped"].includes(result.status)) return result;
          if (result.status !== "running") throw new Error(`Unknown process status: ${result.status}`);
          lastError = undefined;
        } catch (error) {
          controller.signal.throwIfAborted();
          const retryable = isTransientResetError(error) || isRetryableGatewayError(error)
            || (error instanceof ResponseError && [408, 429, 500].includes(error.status ?? 0))
            || (error instanceof TypeError && /^(fetch failed|Failed to fetch|NetworkError when attempting to fetch resource\.)$/.test(error.message));
          if (!retryable) throw error;
          lastError = error;
        }
        // A failed observation uses the same polling cadence as a running process.
        await new Promise<void>(resolve => { pollTimer = setTimeout(resolve, interval); });
      }
    };
    try {
      return await Promise.race([poll(), interrupted]);
    } finally {
      clearTimeout(timeout);
      clearTimeout(pollTimer);
      signal?.removeEventListener("abort", cancel);
    }
  }

  /** One long-poll on GET /process/{identifier}/wait; undefined when the sandbox predates the route. */
  private async waitOnce(identifier: string, timeout: number, signal: AbortSignal): Promise<GetProcessByIdentifierResponse | undefined> {
    // A request stalled past hold + 10s is dropped and retried by wait() like a lost connection.
    // ponytail: AbortController + setTimeout, AbortSignal.any needs Node 20.3+ and engines allows 18.
    const request = new AbortController();
    let stalled = false;
    const timer = setTimeout(() => { stalled = true; request.abort(); }, (timeout + PROCESS_WAIT_GRACE_SECONDS) * 1000);
    // Clear here too: a transport that ignores abort never reaches the finally below.
    const forward = () => { clearTimeout(timer); request.abort(signal.reason); };
    signal.addEventListener("abort", forward, { once: true });
    try {
      // Not in the generated client yet (ENG-6233): same call shape as getProcessByIdentifier.
      const { response, data, error } = await this.client.get<GetProcessByIdentifierResponse, unknown, false>({
        security: [{ scheme: "bearer", type: "http" }],
        url: "/process/{identifier}/wait",
        path: { identifier },
        query: { timeout },
        baseUrl: this.url,
        signal: request.signal,
      });
      // gin answers an unknown route with a plain-text 404; the endpoint's own 404 is JSON.
      if (response.status === 404 && typeof error === "string") return undefined;
      this.handleResponseError(response, data, error);
      return data;
    } catch (error) {
      if (stalled && !signal.aborted) throw new TypeError("fetch failed", { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", forward);
    }
  }

  /**
   * Get a process, running or ended, with its status and output. Retried on
   * transient connection resets unless `retry` is false.
   *
   * @param identifier - The process `pid` or `name`.
   * @param options - `signal` to cancel the request; `retry` (default true).
   * @returns The process: `status`, `exitCode`, timestamps, settings, and `stdout`, `stderr` and `logs` holding the last 64 KB of each stream (use `logs()` for more).
   * @throws ResponseError with status 404 when no process matches.
   */
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
    // wait owns the retry budget; standalone reads retain their existing retries.
    return retry ? retryOnTransientReset(read) : read();
  }

  /**
   * List the processes of the sandbox, running and ended. Each entry carries
   * the last 64 KB of each output stream.
   *
   * @returns The processes.
   */
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

  /**
   * Ask a process to stop gracefully (SIGTERM). Returns once the signal is
   * sent; use `wait()` to know when the process has ended, and `kill()` if it
   * does not.
   *
   * @param identifier - The process `pid` or `name`.
   * @returns A confirmation message.
   */
  async stop(identifier: string): Promise<DeleteProcessByIdentifierResponse> {
    const { response, data, error } = await deleteProcessByIdentifier(this.withClient({
      path: { identifier },
      baseUrl: this.url,
    }));
    this.handleResponseError(response, data, error);
    return data as DeleteProcessByIdentifierResponse;
  }

  /**
   * Stop a process immediately (SIGKILL).
   *
   * @param identifier - The process `pid` or `name`.
   * @returns A confirmation message.
   */
  async kill(identifier: string): Promise<DeleteProcessByIdentifierKillResponse> {
    const { response, data, error } = await deleteProcessByIdentifierKill(this.withClient({
      path: { identifier },
      baseUrl: this.url,
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

  /**
   * Get the output of a process so far, running or ended.
   *
   * @param identifier - The process `pid` or `name`.
   * @param type - `"stdout"`, `"stderr"` or `"all"` (default). `"all"` is
   * stdout followed by stderr, not interleaved in time order; use
   * `streamLogs()` or exec callbacks for live, ordered output.
   * @returns The output as one string (the last 4 MB of each stream at most), empty when there is none.
   */
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
