/* eslint-disable no-console */
import { SeverityNumber } from "@opentelemetry/api-logs";
import { env } from "process";
import { telemetryManager } from "../instrumentation/telemetryManager.js";

const originalLogger = {
  info: console.info,
  error: console.error,
  warn: console.warn,
  debug: console.debug,
  log: console.log,
};

/**
 * Stringify an object with a limited depth
 * @param obj The object to stringify
 * @param maxDepth Maximum depth (default: 1)
 * @param depth Current depth (internal use)
 */
export function stringify<T>(obj: T, maxDepth: number = 1, depth: number = 0): string {
  if (obj instanceof Error) return obj.stack || obj.message;
  if (obj === null) return 'null';
  if (obj === undefined) return 'undefined';

  // If we've reached max depth or it's not an object
  if (depth >= maxDepth || typeof obj !== 'object') {
    return typeof obj === 'object' ? `[${Array.isArray(obj) ? 'Array' : 'object'}]` :
           typeof obj === 'string' ? `"${obj}"` : String(obj);
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return `[${obj.map(item => stringify(item, maxDepth, depth + 1)).join(', ')}]`;
  }

  // Handle objects
  const pairs = Object.entries(obj as Record<string, unknown>).map(([key, val]) =>
    `"${key}": ${stringify(val, maxDepth, depth + 1)}`
  );

  return `{${pairs.join(', ')}}`;
}

// Format a log message with appropriate color and prefix
function formatLogMessage(message: unknown, args: unknown[]): string {
  const messageStr = typeof message === "string" ? message : stringify(message, 2);
  const argsStr = args.map(arg => typeof arg === "string" ? arg : stringify(arg, 2)).join(" ");

  return `${messageStr}${argsStr ? " " + argsStr : ""}`;
}

async function emitLog(severityNumber: SeverityNumber, message: string) {
  const loggerInstance = await telemetryManager.getLogger()
  loggerInstance.emit({
    severityNumber: severityNumber,
    body: message,
  });
}

function emitLogSync(severityNumber: SeverityNumber, message: string) {
  if (env.BL_DEBUG_TELEMETRY === "true") return
  emitLog(severityNumber, message).catch(() => {});
}

console.debug = (message: unknown, ...args: unknown[]) => {
  const msg = formatLogMessage(message, args)
  originalLogger.log(msg);
  emitLogSync(SeverityNumber.DEBUG, msg);
};

console.log = (message: unknown, ...args: unknown[]) => {
  const msg = formatLogMessage(message, args)
  originalLogger.log(msg);
  emitLogSync(SeverityNumber.INFO, msg);
};

console.info = (message: unknown, ...args: unknown[]) => {
  const msg = formatLogMessage(message, args)
  originalLogger.log(msg);
  emitLogSync(SeverityNumber.INFO, msg);
};

console.error = (message: unknown, ...args: unknown[]) => {
  const msg = formatLogMessage(message, args)
  originalLogger.log(msg);
  emitLogSync(SeverityNumber.ERROR, msg);
};

console.warn = (message: unknown, ...args: unknown[]) => {
  const msg = formatLogMessage(message, args)
  originalLogger.log(msg);
  emitLogSync(SeverityNumber.WARN, msg);
};

export const logger = console;