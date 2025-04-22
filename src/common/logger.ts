/* eslint-disable no-console */
import { Logger, SeverityNumber } from "@opentelemetry/api-logs";
import localLogger from "../instrumentation/localLogger.js";
import { telemetryManager } from "../instrumentation/telemetryManager.js";

const originalLogger = {
  info: console.info,
  error: console.error,
  warn: console.warn,
  debug: console.debug,
  log: console.log,
};

console.log = (...args: unknown[]) => {
  originalLogger.log(...args);
  logger.emit(SeverityNumber.INFO, ...args);
};

console.info = (...args: unknown[]) => {
  originalLogger.info(...args);
  logger.emit(SeverityNumber.INFO, ...args);
};

console.error = (...args: unknown[]) => {
  originalLogger.error(...args);
  logger.emit(SeverityNumber.ERROR, ...args);
};

console.warn = (...args: unknown[]) => {
  originalLogger.warn(...args);
  logger.emit(SeverityNumber.WARN, ...args);
};

console.debug = (...args: unknown[]) => {
  originalLogger.debug(...args);
  logger.emit(SeverityNumber.DEBUG, ...args);
};

export const logger = {
  async getLogger(): Promise<Logger> {
    return await telemetryManager.getLogger();
  },

  asyncEmit: async (
    severityNumber: SeverityNumber,
    ...args: unknown[]
  ) => {
    const loggerInstance = await logger.getLogger();
    const safeArgs = args.map((arg) =>
      typeof arg === "string" ? arg : JSON.stringify(arg)
    );
    loggerInstance.emit({
      severityNumber: severityNumber,
      body: safeArgs.join(" "),
      attributes: { args: safeArgs },
    });
  },
  emit: (severityNumber: SeverityNumber, ...args: unknown[]) => {
    logger.asyncEmit(severityNumber, ...args).catch((err) => {
      console.error(err);
    });
  },
  info: (...args: unknown[]) => {
    const safeArgs = args.map((arg) =>
      typeof arg === "string" ? arg : JSON.stringify(arg)
    );
    const msg = safeArgs.join(" ");
    localLogger.info(msg, ...safeArgs);
  },
  error: (...args: unknown[]) => {
    if(args[0] instanceof Error){
      const error = args[0];
      args[0] = error.stack;
    }
    const safeArgs = args.map((arg) =>
      typeof arg === "string" ? arg : JSON.stringify(arg)
    );
    const msg = safeArgs.join(" ");
    localLogger.error(msg, ...safeArgs);
  },
  warn: (...args: unknown[]) => {
    const safeArgs = args.map((arg) =>
      typeof arg === "string" ? arg : JSON.stringify(arg)
    );
    const msg = safeArgs.join(" ");
    localLogger.warn(msg, ...safeArgs);
  },
  debug: (...args: unknown[]) => {
    const safeArgs = args.map((arg) =>
      typeof arg === "string" ? arg : JSON.stringify(arg)
    );
    const msg = safeArgs.join(" ");
    localLogger.debug(msg, ...safeArgs);
  },
};
