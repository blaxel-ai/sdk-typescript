/* eslint-disable no-console */
import { stringify } from "@blaxel/core";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { blaxelTelemetry } from "./telemetry";

export function setLegacyLogger() {
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
}


export const originalLogger = {
  info: console.info,
  error: console.error,
  warn: console.warn,
  debug: console.debug,
  log: console.log,
};

// Format a log message with appropriate color and prefix
function formatLogMessage(message: unknown, args: unknown[]): string {
  const messageStr = typeof message === "string" ? message : stringify(message, 2);
  const argsStr = args.map(arg => typeof arg === "string" ? arg : stringify(arg, 2)).join(" ");

  return `${messageStr}${argsStr ? " " + argsStr : ""}`;
}

async function emitLog(severityNumber: SeverityNumber, message: string) {
  const loggerInstance = await blaxelTelemetry.getLogger()
  loggerInstance.emit({
    severityNumber: severityNumber,
    body: message,
  });
}

function emitLogSync(severityNumber: SeverityNumber, message: string) {
  emitLog(severityNumber, message).catch(() => {});
}

