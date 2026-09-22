import { backoffDelayMs, isRetryableGatewayError, isTransientResetError } from "../../common/transient-retry.js";
import type { ProcessResponse } from "../client/index.js";

export type ProcessWaitOptions = {
  /** Overall observation deadline in milliseconds, including HTTP requests. */
  maxWait?: number;
  interval?: number;
  /** Cancels observation only. Use killAndWait/stopAndWait to stop the command. */
  signal?: AbortSignal;
};

/** Failure to observe a command, not evidence that the command failed or stopped. */
export class ProcessObservationError extends Error {
  constructor(
    public readonly identifier: string,
    public readonly reason: "timeout" | "cancelled" | "status",
    public readonly lastObservation: ProcessResponse | undefined,
    cause?: unknown,
  ) {
    const detail = reason === "timeout" ? "Process did not finish in time" : reason === "cancelled" ? "Process observation cancelled" : "Could not retrieve process status";
    super(`${detail} (${identifier}). The command may still be running; reconnect with get/wait/logs using this identifier.`, { cause });
    this.name = "ProcessObservationError";
  }
}

/** The request failed; the command may already have started. Never retry it blindly. */
export class ProcessExecutionError extends Error {
  constructor(public readonly identifier: string, cause: unknown) {
    super(`Could not confirm execution of process ${identifier}. Reconnect with get/wait/logs using this identifier before starting another command.`, { cause });
    this.name = "ProcessExecutionError";
  }
}

const TERMINAL_STATES = new Set(["completed", "failed", "killed", "stopped"]);
function isRetryableObservationError(error: unknown): boolean {
  if (isTransientResetError(error) || isRetryableGatewayError(error)) return true;
  if (!error || typeof error !== "object") return false;
  const value = error as { status?: number; response?: { status?: number }; name?: string; message?: string; cause?: { code?: string } };
  const status = value.status ?? value.response?.status;
  if (status !== undefined) return [408, 429, 500, 502, 503, 504].includes(status);
  return value.name === "TimeoutError" || (value.name === "TypeError" && /^(Failed to fetch|fetch failed|NetworkError when attempting to fetch resource\.)$/.test(value.message ?? "")) || ["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET", "EAI_AGAIN"].includes(value.cause?.code ?? "");
}

/** Bound even a custom transport that does not honor AbortSignal. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    if (signal.aborted) onAbort();
  });
}
function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export async function observeProcess(
  identifier: string,
  read: (signal: AbortSignal) => Promise<ProcessResponse>,
  { maxWait = 60000, interval = 1000, signal }: ProcessWaitOptions = {},
  before?: (signal: AbortSignal) => Promise<unknown>,
): Promise<ProcessResponse> {
  if (!Number.isFinite(maxWait) || maxWait < 0 || !Number.isFinite(interval) || interval <= 0) {
    throw new RangeError("maxWait must be finite and non-negative; interval must be finite and positive");
  }
  let lastObservation: ProcessResponse | undefined;
  let lastError: unknown;
  let terminationError: unknown;
  let failures = 0;
  const controller = new AbortController();
  const cancelled = () => controller.abort("cancelled");
  signal?.addEventListener("abort", cancelled, { once: true });
  if (signal?.aborted) cancelled();
  const timeout = setTimeout(() => controller.abort("timeout"), maxWait);
  const deadline = performance.now() + maxWait;
  try {
    controller.signal.throwIfAborted();
    if (maxWait === 0) { controller.abort("timeout"); controller.signal.throwIfAborted(); }
    if (before) {
      try { await abortable(before(controller.signal), controller.signal); }
      catch (error) {
        if (controller.signal.aborted) throw error;
        if (!isRetryableObservationError(error)) throw new ProcessObservationError(identifier, "status", lastObservation, error);
        // The signal may already have been delivered. Observe without resending it.
        terminationError = error;
      }
    }
    while (true) {
      if (performance.now() >= deadline && !controller.signal.aborted) controller.abort("timeout");
      controller.signal.throwIfAborted();
      let delay = interval;
      try {
        const observation = await abortable(read(controller.signal), controller.signal);
        lastObservation = observation;
        if (performance.now() >= deadline) { controller.abort("timeout"); controller.signal.throwIfAborted(); }
        lastError = undefined;
        failures = 0;
        if (TERMINAL_STATES.has(observation.status)) return observation;
        if (observation.status !== "running") throw new Error(`Unknown process status: ${observation.status}`);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        lastError = error;
        if (!isRetryableObservationError(error)) throw new ProcessObservationError(identifier, "status", lastObservation, error);
        delay = backoffDelayMs(++failures, 100, 1000);
      }
      await sleep(Math.min(delay, Math.max(0, deadline - performance.now())), controller.signal);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ProcessObservationError(identifier, controller.signal.reason === "cancelled" ? "cancelled" : "timeout", lastObservation, signal?.aborted ? signal.reason : lastError ?? terminationError ?? error);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancelled);
  }
}
