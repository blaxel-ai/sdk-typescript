/** Line callbacks omit delimiters. Chunk callbacks preserve the original bytes. */
export type StreamLogsOptions = {
  onLog?: (log: string) => void;
  onStdout?: (stdout: string) => void;
  onStderr?: (stderr: string) => void;
  onStdoutChunk?: (chunk: Uint8Array) => void;
  onStderrChunk?: (chunk: Uint8Array) => void;
  onError?: (error: Error) => void;
};

type Source = "stdout" | "stderr";

function emitLogLine(options: StreamLogsOptions, source: Source, line: string) {
  if (source === "stdout") options.onStdout?.(line);
  else options.onStderr?.(line);
  options.onLog?.(line);
}

function createStructuredLogParser(options: StreamLogsOptions) {
  const states = {
    stdout: { decoder: new TextDecoder("utf-8", { ignoreBOM: true }), buffer: "" },
    stderr: { decoder: new TextDecoder("utf-8", { ignoreBOM: true }), buffer: "" },
  };
  const needsLines = (source: Source) => Boolean(options.onLog || (source === "stdout" ? options.onStdout : options.onStderr));
  const lines = (source: Source, text: string, final = false) => {
    const state = states[source];
    state.buffer += text;
    let newline: number;
    while ((newline = state.buffer.indexOf("\n")) !== -1) {
      const line = state.buffer.slice(0, newline);
      state.buffer = state.buffer.slice(newline + 1);
      emitLogLine(options, source, line.endsWith("\r") ? line.slice(0, -1) : line);
    }
    if (final && state.buffer.length > 0) {
      const tail = state.buffer;
      state.buffer = "";
      emitLogLine(options, source, tail);
    }
  };
  const flush = () => {
    for (const source of ["stdout", "stderr"] as const) {
      if (!needsLines(source)) continue;
      lines(source, states[source].decoder.decode(), true);
    }
  };
  const record = (line: string) => {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || !("type" in value)) {
      throw new Error("Invalid process log record");
    }
    const { type } = value;
    if (type === "keepalive") return;
    if (type === "restart") {
      flush();
      return;
    }
    if (type === "truncated" || type === "error") {
      const detail = "data" in value && typeof value.data === "string" ? `: ${value.data}` : "";
      throw new Error(`Process log stream ${type}${detail}`);
    }
    if ((type !== "stdout" && type !== "stderr") || !("data" in value) || typeof value.data !== "string") {
      throw new Error("Invalid process log record");
    }
    let bytes: Uint8Array;
    if ("encoding" in value && value.encoding !== undefined && value.encoding !== "") {
      if (value.encoding !== "base64") throw new Error("Unsupported process log encoding");
      // atob is available in supported Node and browser runtimes. Validate the
      // base64 alphabet and padding because atob accepts some malformed forms.
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) {
        throw new Error("Invalid base64 process log data");
      }
      bytes = Uint8Array.from(atob(value.data), (character) => character.charCodeAt(0));
    } else {
      bytes = new TextEncoder().encode(value.data);
    }
    // Decode before handing bytes to user code, which may mutate its chunk.
    const text = needsLines(type) ? states[type].decoder.decode(bytes, { stream: true }) : "";
    if (type === "stdout") options.onStdoutChunk?.(bytes);
    else options.onStderrChunk?.(bytes);
    if (needsLines(type)) lines(type, text);
  };
  return { record, flush, abort: flush };
}

function createLegacyLogParser(options: StreamLogsOptions) {
  const record = (line: string) => {
    if (line.startsWith("[keepalive]")) return;
    if (line.startsWith("stdout:")) emitLogLine(options, "stdout", line.slice(7));
    else if (line.startsWith("stderr:")) emitLogLine(options, "stderr", line.slice(7));
    else options.onLog?.(line);
  };
  return {
    record,
    flush: () => {},
    abort: (partial: string) => { if (partial.trim()) record(partial); },
  };
}

// Own transport framing and format-specific completion in the same parser.
export function createLogStreamParser(options: StreamLogsOptions, format: "ndjson" | "text") {
  const records = format === "ndjson" ? createStructuredLogParser(options) : createLegacyLogParser(options);
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    push(bytes: Uint8Array) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop()!;
      for (const line of lines) records.record(line);
    },
    finish() {
      buffer += decoder.decode();
      if (buffer.length > 0) records.record(buffer);
      buffer = "";
      records.flush();
    },
    abort() {
      // Legacy text can flush its partial line. An unfinished NDJSON frame is discarded.
      records.abort(buffer);
      buffer = "";
    },
  };
}
