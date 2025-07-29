/* eslint-disable no-console */

import { env, stringify } from '@blaxel/core';
import { trace } from '@opentelemetry/api';

export function setJsonLogger() {
  console.debug = (message: unknown, ...args: unknown[]) => {
    const msg = formatLogMessage("DEBUG", message, args)
    originalLogger.log(msg);
  };

  console.log = (message: unknown, ...args: unknown[]) => {
    const msg = formatLogMessage("INFO", message, args)
    originalLogger.log(msg);
  };

  console.info = (message: unknown, ...args: unknown[]) => {
    const msg = formatLogMessage("INFO", message, args)
    originalLogger.log(msg);
  };

  console.warn = (message: unknown, ...args: unknown[]) => {
    const msg = formatLogMessage("WARN", message, args)
    originalLogger.log(msg);
  };

  console.error = (message: unknown, ...args: unknown[]) => {
    const msg = formatLogMessage("ERROR", message, args)
    originalLogger.log(msg);
  };
}


export const originalLogger = {
  info: console.info,
  error: console.error,
  warn: console.warn,
  debug: console.debug,
  log: console.log,
};


const traceIdName = env.BL_LOGGER_TRACE_ID || 'trace_id'
const spanIdName = env.BL_LOGGER_SPAN_ID || 'span_id'
const labelsName = env.BL_LOGGER_LABELS || 'labels'
const traceIdPrefix = env.BL_LOGGER_TRACE_ID_PREFIX || ''
const spanIdPrefix = env.BL_LOGGER_SPAN_ID_PREFIX || ''
const taskIndex = env.BL_TASK_KEY || 'TASK_INDEX'
const taskPrefix = env.BL_TASK_PREFIX || ''
const executionKey = env.BL_EXECUTION_KEY || 'BL_EXECUTION_ID'
const executionPrefix = env.BL_EXECUTION_PREFIX || ''

// Validate environment variables to prevent issues
function validateEnvVar(value: string, defaultValue: string, varName: string): string {
  if (!value || value.trim() === '') {
    originalLogger.warn(`Warning: ${varName} environment variable is empty, using default: ${defaultValue}`);
    return defaultValue;
  }
  return value;
}

const validatedLabelsName = validateEnvVar(labelsName, 'labels', 'BL_LOGGER_LABELS');

// Enhanced error serialization to capture all properties
function serializeError(error: Error): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    message: error.message,
    name: error.name,
    stack: error.stack
  };

  // Capture any additional properties on the error object
  for (const key of Object.keys(error)) {
    if (!(key in serialized)) {
      try {
        const value = (error as unknown as Record<string, unknown>)[key];
        // Avoid circular references by limiting depth
        serialized[key] = typeof value === 'object' ? stringify(value, 2) : value;
      } catch {
        serialized[key] = '[Unserializable]';
      }
    }
  }

  return serialized;
}

// Enhanced stringify function with better error handling
function enhancedStringify(obj: unknown, maxDepth: number = 2): string {
  if (obj instanceof Error) {
    return JSON.stringify(serializeError(obj));
  }

  // Handle circular references by using a simple set to track seen objects
  const seen = new WeakSet();

  const stringifyWithCircularCheck = (value: unknown, depth: number = 0): unknown => {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;

    if (seen.has(value)) {
      return '[Circular Reference]';
    }

    if (depth >= maxDepth) {
      return Array.isArray(value) ? '[Array]' : '[Object]';
    }

    seen.add(value);

    if (Array.isArray(value)) {
      return value.map(item => stringifyWithCircularCheck(item, depth + 1));
    }

    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = stringifyWithCircularCheck(val, depth + 1);
    }

    return result;
  };

  try {
    const processed = stringifyWithCircularCheck(obj);
    return JSON.stringify(processed);
  } catch {
    return stringify(obj, maxDepth);
  }
}

// Format a log message with appropriate color and prefix
function formatLogMessage(severity: string, message: unknown, args: unknown[]): string {
  const messageStr = typeof message === "string" ? message : enhancedStringify(message, 2);
  const argsStr = args.map(arg => typeof arg === "string" ? arg : enhancedStringify(arg, 2)).join(" ");

  const msg = `${messageStr}${argsStr ? " " + argsStr : ""}`;

  interface LogEntry {
    message: string;
    severity: string;
    [key: string]: string | Record<string, string>;
  }

  const logEntry: LogEntry = {
    message: msg,
    severity
  };

  logEntry[validatedLabelsName] = {} as Record<string, string>;

  const currentSpan = trace.getActiveSpan();
  if (currentSpan) {
    const {traceId, spanId} = currentSpan.spanContext();
    logEntry[traceIdName] = `${traceIdPrefix}${traceId}`;
    logEntry[spanIdName] = `${spanIdPrefix}${spanId}`;
  }

  const taskId = env[taskIndex] || null
  if (taskId) {
    logEntry[validatedLabelsName]['blaxel-task'] = `${taskPrefix}${taskId}`
  }

  const executionId = env[executionKey] || null
  if (executionId) {
    logEntry[validatedLabelsName]['blaxel-execution'] = `${executionPrefix}${executionId.split('-').pop()}`;
  }

  try {
    return JSON.stringify(logEntry);
  } catch (error) {
    // Fallback for serialization errors
    const fallbackEntry = {
      message: `JSON serialization failed: ${msg}`,
      severity,
      error: error instanceof Error ? error.message : String(error)
    };
    try {
      return JSON.stringify(fallbackEntry);
    } catch {
      // Last resort fallback
      return `{"message":"${severity}: ${msg.replace(/"/g, '\\"')}","severity":"${severity}","error":"Failed to serialize log entry"}`;
    }
  }
}
