export type SandboxDiagnosticPrimitive = string | number | boolean | null;
export type SandboxDiagnosticValue =
  | SandboxDiagnosticPrimitive
  | SandboxDiagnosticValue[]
  | { [key: string]: SandboxDiagnosticValue };

export type SandboxOperationStatus = "ok" | "error";

export type SandboxOperationEvent = {
  id: string;
  sandboxName?: string;
  subsystem: string;
  operation: string;
  status: SandboxOperationStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  transport?: {
    h2Domain?: string;
    forcedUrl: boolean;
  };
  attributes?: Record<string, SandboxDiagnosticValue>;
  result?: Record<string, SandboxDiagnosticValue>;
  error?: {
    name: string;
    message: string;
    status?: number;
    code?: string | number;
  };
};

export type SandboxOperationRecorderOptions = {
  maxEvents?: number;
  maxStringLength?: number;
  captureCommandText?: boolean;
  redactKeys?: string[];
  clock?: () => number;
  now?: () => string;
  idFactory?: () => string;
};

export type SandboxOperationStart = {
  sandboxName?: string;
  subsystem: string;
  operation: string;
  attributes?: Record<string, unknown>;
  transport?: {
    h2Domain?: string | null;
    forcedUrl?: boolean;
  };
};

type PendingSandboxOperation = {
  id: string;
  startedAtMs: number;
  startedAt: string;
} & SandboxOperationStart;

const DEFAULT_MAX_EVENTS = 200;
const DEFAULT_MAX_STRING_LENGTH = 512;
const DEFAULT_REDACT_KEYS = [
  "authorization",
  "api_key",
  "apikey",
  "cookie",
  "password",
  "secret",
  "token",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasRedactedKey(key: string, redactKeys: string[]): boolean {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, "");
  return redactKeys.some((redactKey) => normalized.includes(redactKey.toLowerCase().replace(/[-_\s]/g, "")));
}

function errorField(error: unknown, field: "status" | "code"): string | number | undefined {
  if (!isPlainObject(error) || !(field in error)) return undefined;
  const value = error[field];
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

export class SandboxOperationRecorder {
  private events: SandboxOperationEvent[] = [];
  private sequence = 0;
  private readonly maxEvents: number;
  private readonly maxStringLength: number;
  private readonly captureCommandText: boolean;
  private readonly redactKeys: string[];
  private readonly clock: () => number;
  private readonly now: () => string;
  private readonly idFactory?: () => string;

  constructor(options: SandboxOperationRecorderOptions = {}) {
    this.maxEvents = Math.max(1, options.maxEvents ?? DEFAULT_MAX_EVENTS);
    this.maxStringLength = Math.max(16, options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH);
    this.captureCommandText = options.captureCommandText ?? false;
    this.redactKeys = [...DEFAULT_REDACT_KEYS, ...(options.redactKeys ?? [])];
    this.clock = options.clock ?? Date.now;
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory;
  }

  start(operation: SandboxOperationStart): PendingSandboxOperation {
    const id = this.idFactory?.() ?? `sandbox-op-${++this.sequence}`;
    return {
      id,
      startedAtMs: this.clock(),
      startedAt: this.now(),
      ...operation,
    };
  }

  end(
    pending: PendingSandboxOperation,
    status: SandboxOperationStatus,
    result?: Record<string, unknown>,
    error?: unknown,
  ): SandboxOperationEvent {
    const event: SandboxOperationEvent = {
      id: pending.id,
      sandboxName: pending.sandboxName,
      subsystem: pending.subsystem,
      operation: pending.operation,
      status,
      startedAt: pending.startedAt,
      endedAt: this.now(),
      durationMs: Math.max(0, this.clock() - pending.startedAtMs),
      transport: pending.transport
        ? {
            h2Domain: pending.transport.h2Domain ?? undefined,
            forcedUrl: pending.transport.forcedUrl ?? false,
          }
        : undefined,
      attributes: pending.attributes ? this.sanitizeRecord(pending.attributes) : undefined,
      result: result ? this.sanitizeRecord(result) : undefined,
      error: error ? this.sanitizeError(error) : undefined,
    };

    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    return event;
  }

  command(command: string): Record<string, SandboxDiagnosticValue> {
    const attributes: Record<string, SandboxDiagnosticValue> = {
      commandLength: command.length,
      commandText: "[redacted]",
    };
    if (this.captureCommandText) {
      attributes.commandText = this.truncate(command);
    }
    return attributes;
  }

  sanitizeRecord(record: Record<string, unknown>): Record<string, SandboxDiagnosticValue> {
    const sanitized = this.sanitize(record);
    return isPlainObject(sanitized) ? sanitized as Record<string, SandboxDiagnosticValue> : {};
  }

  snapshot(): SandboxOperationEvent[] {
    return JSON.parse(JSON.stringify(this.events)) as SandboxOperationEvent[];
  }

  toJSON(): { events: SandboxOperationEvent[] } {
    return { events: this.snapshot() };
  }

  toString(): string {
    return JSON.stringify(this.toJSON(), null, 2);
  }

  clear(): void {
    this.events = [];
  }

  private sanitize(value: unknown, key = "", depth = 0): SandboxDiagnosticValue {
    if (hasRedactedKey(key, this.redactKeys)) return "[redacted]";
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return this.truncate(value);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Error) return this.truncate(value.message);
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Blob) return { type: "Blob", size: value.size, mediaType: value.type || null };
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
      return { type: "Buffer", byteLength: value.byteLength };
    }
    if (ArrayBuffer.isView(value)) {
      return { type: value.constructor.name, byteLength: value.byteLength };
    }
    if (value instanceof ArrayBuffer) return { type: "ArrayBuffer", byteLength: value.byteLength };
    if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
    if (depth >= 4) return Array.isArray(value) ? "[array]" : "[object]";
    if (Array.isArray(value)) return value.slice(0, 25).map((item) => this.sanitize(item, key, depth + 1));
    if (isPlainObject(value)) {
      const output: Record<string, SandboxDiagnosticValue> = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        output[childKey] = this.sanitize(childValue, childKey, depth + 1);
      }
      return output;
    }
    return this.truncate(Object.prototype.toString.call(value));
  }

  private sanitizeError(error: unknown): SandboxOperationEvent["error"] {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    const status = errorField(error, "status");
    const code = errorField(error, "code");
    return {
      name,
      message: this.truncate(message),
      status: typeof status === "number" ? status : undefined,
      code,
    };
  }

  private truncate(value: string): string {
    if (value.length <= this.maxStringLength) return value;
    return `${value.slice(0, this.maxStringLength)}...`;
  }
}
