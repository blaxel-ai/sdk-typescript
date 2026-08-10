import { posix as path } from "node:path";
import { randomUUID } from "node:crypto";

import { SandboxInstance } from "@blaxel/core";
import type {
  SandboxCommandResult,
  SandboxNetworkPolicy,
  SandboxProcess,
  SandboxReadFileOptions,
  SandboxReadTextFileOptions,
  SandboxRunOptions,
  SandboxSession,
  SandboxSpawnOptions,
  SandboxWriteFileOptions,
  SandboxWriteTextFileOptions,
} from "eve/sandbox";

import { toBlaxelNetworkPolicy } from "./network-policy.js";

const WORKSPACE_ROOT = "/workspace";
const DEFAULT_PROCESS_OUTPUT_BUFFER_BYTES = 1024 * 1024;

type SandboxRemovePathOptions = {
  readonly abortSignal?: AbortSignal;
  readonly force?: boolean;
  readonly path: string;
  readonly recursive?: boolean;
};

export type CreateBlaxelEveSessionOptions = {
  readonly id: string;
  readonly processOutputBufferBytes?: number;
  readonly registerProcessStream?: (close: () => void) => () => void;
  readonly sandbox: SandboxInstance;
};

/** Build eve's public sandbox session over one Blaxel sandbox. */
export function createBlaxelEveSession(
  options: CreateBlaxelEveSessionOptions,
): SandboxSession {
  const { sandbox } = options;
  const processOutputBufferBytes =
    options.processOutputBufferBytes ?? DEFAULT_PROCESS_OUTPUT_BUFFER_BYTES;

  const session: SandboxSession = {
    id: options.id,
    resolvePath,
    async run(runOptions: SandboxRunOptions): Promise<SandboxCommandResult> {
      const { completion, process } = await spawnInternal(runOptions);
      const [streamedStdout, streamedStderr, result] = await Promise.all([
        streamToString(process.stdout),
        streamToString(process.stderr),
        completion,
      ]);
      return {
        exitCode: result.exitCode,
        stdout: result.stdout ?? streamedStdout,
        stderr: result.stderr ?? streamedStderr,
      };
    },
    spawn,
    async readFile(readOptions: SandboxReadFileOptions) {
      throwIfAborted(readOptions.abortSignal);
      try {
        const blob = await sandbox.fs.readBinary(resolvePath(readOptions.path));
        throwIfAborted(readOptions.abortSignal);
        return bytesToStream(new Uint8Array(await blob.arrayBuffer()));
      } catch (error) {
        if (isNotFoundError(error)) return null;
        throw error;
      }
    },
    async readBinaryFile(readOptions) {
      const stream = await session.readFile(readOptions);
      return stream === null ? null : streamToBytes(stream);
    },
    async readTextFile(readOptions: SandboxReadTextFileOptions) {
      validateReadTextFileOptions(readOptions);
      const bytes = await session.readBinaryFile(readOptions);
      if (bytes === null) return null;
      return applyLineRange(
        decodeBytes(bytes, readOptions.encoding ?? "utf-8"),
        readOptions,
      );
    },
    async writeFile(writeOptions: SandboxWriteFileOptions) {
      throwIfAborted(writeOptions.abortSignal);
      const target = resolvePath(writeOptions.path);
      await ensureParentDirectory(sandbox, target);
      const bytes = await streamToBytes(writeOptions.content);
      throwIfAborted(writeOptions.abortSignal);
      await sandbox.fs.writeBinary(target, bytes);
    },
    async writeBinaryFile(writeOptions) {
      throwIfAborted(writeOptions.abortSignal);
      const target = resolvePath(writeOptions.path);
      await ensureParentDirectory(sandbox, target);
      await sandbox.fs.writeBinary(target, toUint8Array(writeOptions.content));
      throwIfAborted(writeOptions.abortSignal);
    },
    async writeTextFile(writeOptions: SandboxWriteTextFileOptions) {
      throwIfAborted(writeOptions.abortSignal);
      const target = resolvePath(writeOptions.path);
      await ensureParentDirectory(sandbox, target);
      const encoding = writeOptions.encoding ?? "utf-8";
      if (encoding === "utf-8" || encoding === "utf8") {
        await sandbox.fs.write(target, writeOptions.content);
      } else {
        await sandbox.fs.writeBinary(
          target,
          Buffer.from(writeOptions.content, encoding as BufferEncoding),
        );
      }
      throwIfAborted(writeOptions.abortSignal);
    },
    async removePath(removeOptions: SandboxRemovePathOptions) {
      throwIfAborted(removeOptions.abortSignal);
      try {
        await sandbox.fs.rm(resolvePath(removeOptions.path), removeOptions.recursive ?? false);
      } catch (error) {
        if (removeOptions.force && isNotFoundError(error)) return;
        throw error;
      }
      throwIfAborted(removeOptions.abortSignal);
    },
    async setNetworkPolicy(policy: SandboxNetworkPolicy) {
      await SandboxInstance.updateNetwork(sandbox.metadata.name, {
        network: toBlaxelNetworkPolicy(policy),
      });
    },
  };

  return session;

  async function spawn(spawnOptions: SandboxSpawnOptions): Promise<SandboxProcess> {
    return (await spawnInternal(spawnOptions)).process;
  }

  async function spawnInternal(spawnOptions: SandboxSpawnOptions): Promise<{
    completion: Promise<{ exitCode: number; stderr?: string; stdout?: string }>;
    process: SandboxProcess;
  }> {
    throwIfAborted(spawnOptions.abortSignal);
    const result = await sandbox.process.exec({
      command: spawnOptions.command,
      env: spawnOptions.env,
      keepAlive: false,
      name: `eve-${randomUUID()}`,
      timeout: 0,
      waitForCompletion: false,
      workingDir:
        spawnOptions.workingDirectory === undefined
          ? WORKSPACE_ROOT
          : resolvePath(spawnOptions.workingDirectory),
    });
    const pid = result.pid;
    const stdout = createBoundedByteStream(processOutputBufferBytes);
    const stderr = createBoundedByteStream(processOutputBufferBytes);
    let state: "running" | "killed" | "exited" = "running";
    let exitCode = 1;
    let terminalError: Error | undefined;
    let closeStream = () => {};

    const stream = sandbox.process.streamLogs(pid, {
      onStdout: (value) => {
        const error = stdout.push(new TextEncoder().encode(value));
        if (error) failProcess(error);
      },
      onStderr: (value) => {
        const error = stderr.push(new TextEncoder().encode(value));
        if (error) failProcess(error);
      },
      onError: failProcess,
    });
    closeStream = stream.close;
    const unregister = options.registerProcessStream?.(stream.close) ?? (() => {});

    const kill = async () => {
      if (state !== "running") return;
      state = "killed";
      exitCode = 137;
      stream.close();
      await sandbox.process.kill(pid).catch((error: unknown) => {
        if (!isNotFoundError(error)) throw error;
      });
      stdout.finish();
      stderr.finish();
    };
    const abort = () => void kill().catch(failProcess);
    spawnOptions.abortSignal?.addEventListener("abort", abort, { once: true });

    const completed = (async () => {
      try {
        await stream.wait();
        if (terminalError) throw terminalError;
        if ((state as "running" | "killed" | "exited") === "killed") return { exitCode };
        let final = await sandbox.process.get(pid);
        while (final.status === "running") {
          await delay(250);
          final = await sandbox.process.get(pid);
        }
        exitCode = final.exitCode ?? 1;
        state = final.status === "killed" || final.status === "stopped" ? "killed" : "exited";
        stdout.finish();
        stderr.finish();
        return { exitCode, stderr: final.stderr, stdout: final.stdout };
      } catch (error) {
        const normalized = asError(error);
        terminalError ??= normalized;
        stdout.finish(normalized);
        stderr.finish(normalized);
        throw normalized;
      } finally {
        spawnOptions.abortSignal?.removeEventListener("abort", abort);
        unregister();
      }
    })();
    void completed.catch(() => undefined);

    const process: SandboxProcess = {
      stdout: stdout.stream,
      stderr: stderr.stream,
      wait: async () => ({ exitCode: (await completed).exitCode }),
      kill,
    };
    return { completion: completed, process };

    function failProcess(error: Error): void {
      if (terminalError) return;
      terminalError = error;
      closeStream();
      void sandbox.process.kill(pid).catch(() => undefined);
      stdout.finish(error);
      stderr.finish(error);
    }
  }
}

function resolvePath(input: string): string {
  return input.startsWith("/") ? input : `${WORKSPACE_ROOT}/${input}`;
}

async function ensureParentDirectory(sandbox: SandboxInstance, filePath: string): Promise<void> {
  const parent = path.dirname(filePath);
  if (parent === "/" || parent === WORKSPACE_ROOT) return;
  const result = await sandbox.process.exec({
    command: `mkdir -p -- ${shellQuote(parent)}`,
    waitForCompletion: true,
    workingDir: "/",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create parent directory ${parent}: ${result.stderr}`);
  }
}

function createBoundedByteStream(maxBufferedBytes: number) {
  if (!Number.isInteger(maxBufferedBytes) || maxBufferedBytes <= 0) {
    throw new Error("processOutputBufferBytes must be a positive integer");
  }
  const queue: Uint8Array[] = [];
  let bufferedBytes = 0;
  let finished = false;
  let terminalError: Error | undefined;
  let pendingController: ReadableStreamDefaultController<Uint8Array> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (queue.length > 0) {
        const chunk = queue.shift()!;
        bufferedBytes -= chunk.byteLength;
        controller.enqueue(chunk);
        return;
      }
      if (terminalError) {
        controller.error(terminalError);
        return;
      }
      if (finished) {
        controller.close();
        return;
      }
      pendingController = controller;
    },
    cancel() {
      queue.length = 0;
      bufferedBytes = 0;
      pendingController = undefined;
      finished = true;
    },
  });

  return {
    stream,
    push(chunk: Uint8Array): Error | undefined {
      if (finished) return terminalError;
      if (pendingController) {
        const controller = pendingController;
        pendingController = undefined;
        controller.enqueue(chunk);
        return undefined;
      }
      if (bufferedBytes + chunk.byteLength > maxBufferedBytes) {
        const error = new Error(
          `Blaxel process output exceeded the ${maxBufferedBytes}-byte buffer; consume output while the process runs.`,
        );
        this.finish(error);
        return error;
      }
      queue.push(chunk);
      bufferedBytes += chunk.byteLength;
      return undefined;
    },
    finish(error?: Error) {
      if (finished) return;
      finished = true;
      terminalError = error;
      if (!pendingController) return;
      const controller = pendingController;
      pendingController = undefined;
      if (error) controller.error(error);
      else controller.close();
    },
  };
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new TextDecoder().decode(await streamToBytes(stream));
}

function toUint8Array(content: Uint8Array | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
}

function decodeBytes(bytes: Uint8Array, encoding: string): string {
  if (encoding === "utf-8" || encoding === "utf8") {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    encoding as BufferEncoding,
  );
}

function validateReadTextFileOptions(options: SandboxReadTextFileOptions): void {
  const { startLine, endLine } = options;
  if (startLine !== undefined && (!Number.isInteger(startLine) || startLine < 1)) {
    throw new Error("startLine must be a positive integer (1-based).");
  }
  if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < 1)) {
    throw new Error("endLine must be a positive integer (1-based).");
  }
  if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
    throw new Error("startLine must not be greater than endLine.");
  }
}

function applyLineRange(text: string, options: SandboxReadTextFileOptions): string {
  if (options.startLine === undefined && options.endLine === undefined) return text;
  const lines = text.match(/.*(?:\r\n|\r|\n)|.+$/g) ?? [];
  const start = options.startLine ?? 1;
  const end = Math.min(options.endLine ?? lines.length, lines.length);
  return start > lines.length ? "" : lines.slice(start - 1, end).join("");
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; status?: unknown; statusCode?: unknown };
  return candidate.code === 404 || candidate.code === "404" || candidate.status === 404 || candidate.statusCode === 404;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The operation was aborted", "AbortError");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
