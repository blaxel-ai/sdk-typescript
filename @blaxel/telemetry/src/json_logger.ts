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

// Format a log message with appropriate color and prefix
function formatLogMessage(severity: string, message: unknown, args: unknown[]): string {
  const messageStr = typeof message === "string" ? message : stringify(message, 2);
  const argsStr = args.map(arg => typeof arg === "string" ? arg : stringify(arg, 2)).join(" ");

  let msg = `${messageStr}${argsStr ? " " + argsStr : ""}`;

  const logEntry: any = {
    message: msg,
    severity
  };

  const currentSpan = trace.getActiveSpan();
  if (currentSpan) {
    const {traceId, spanId} = currentSpan.spanContext();

    const traceIdName = env.BL_LOGGER_TRACE_ID || 'trace_id'
    const spanIdName = env.BL_LOGGER_SPAN_ID || 'span_id'
    const labelsName = env.BL_LOGGER_LABELS || 'labels'
    const traceIdPrefix = env.BL_LOGGER_TRACE_ID_PREFIX || ''
    const spanIdPrefix = env.BL_LOGGER_SPAN_ID_PREFIX || ''
    const taskId = env.BL_TASK_ID || ''

    logEntry[traceIdName] = `${traceIdPrefix}${traceId}`;
    logEntry[spanIdName] = `${spanIdPrefix}${spanId}`;
    logEntry[labelsName] = {}
    if (taskId) {
      logEntry[labelsName].task_id = taskId
    }

  }

  return JSON.stringify(logEntry);
}