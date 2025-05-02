/* eslint-disable no-console */
import { AnyValue, SeverityNumber } from "@opentelemetry/api-logs";
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
  const pairs = Object.entries(obj as Record<string, any>).map(([key, val]) =>
    `"${key}": ${stringify(val, maxDepth, depth + 1)}`
  );

  return `{${pairs.join(', ')}}`;
}

async function emitLog(severityNumber: SeverityNumber, message: any, ...args: any[]) {
  const loggerInstance = await telemetryManager.getLogger()
  const safeArgs = args.map((arg) =>
    typeof arg === "string" ? arg : stringify(arg, 2)
  );
  loggerInstance.emit({
    severityNumber: severityNumber,
    body: safeArgs.join(" "),
  });
}

function emitLogSync(severityNumber: SeverityNumber, message: any, ...args: any[]) {
  emitLog(severityNumber, message, ...args).catch(() => {}); // eslint-disable-line
}

console.log = (message: any, ...args: AnyValue[]) => {
  originalLogger.log(message, ...args);
  if (env.BL_DEBUG_TELEMETRY === "true") return
  emitLogSync(SeverityNumber.INFO, message, ...args);
};

console.info = (message: any, ...args: any[]) => {
  originalLogger.info(message, ...args); // eslint-disable-line
  if (env.BL_DEBUG_TELEMETRY === "true") return
  emitLogSync(SeverityNumber.INFO, message, ...args); // eslint-disable-line
};

console.error = (message: any, ...args: any[]) => {
  originalLogger.error(message, ...args); // eslint-disable-line
  if (env.BL_DEBUG_TELEMETRY === "true") return
  emitLogSync(SeverityNumber.ERROR, message, ...args); // eslint-disable-line
};

console.warn = (message: any, ...args: any[]) => {
  originalLogger.warn(message, ...args); // eslint-disable-line
  if (env.BL_DEBUG_TELEMETRY === "true") return
  emitLogSync(SeverityNumber.WARN, message, ...args); // eslint-disable-line
};

console.debug = (message: any, ...args: any[]) => {
  originalLogger.debug(message, ...args); // eslint-disable-line
  if (env.BL_DEBUG_TELEMETRY === "true") return
  emitLogSync(SeverityNumber.DEBUG, message, ...args); // eslint-disable-line
};

export const logger = console;