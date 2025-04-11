import { Logger, SeverityNumber } from "@opentelemetry/api-logs";
import localLogger from "../instrumentation/localLogger.js";
import { telemetryManager } from "../instrumentation/telemetryManager.js";

export const logger = {
  async getLogger(): Promise<Logger> {
    return await telemetryManager.getLogger();
  },

  asyncEmit: async (
    severityNumber: SeverityNumber,
    msg: unknown,
    ...args: unknown[]
  ) => {
    const loggerInstance = await logger.getLogger();
    if (typeof msg !== "string") {
      msg = JSON.stringify(msg);
    }
    const safeArgs = args.map((arg) =>
      typeof arg === "string" ? arg : JSON.stringify(arg)
    );
    loggerInstance.emit({
      severityNumber: severityNumber,
      body: msg as string,
      attributes: { args: safeArgs },
    });
  },
  emit: (severityNumber: SeverityNumber, msg: unknown, ...args: unknown[]) => {
    logger.asyncEmit(severityNumber, msg, ...args).catch((err) => {
      console.error(err);
    });
  },
  info: (msg: unknown, ...args: unknown[]) => {
    if (typeof msg !== "string") {
      msg = JSON.stringify(msg);
    }
    const safeArgs = args.map((arg) =>
      typeof arg === "string" ? arg : JSON.stringify(arg)
    );
    localLogger.info(msg, ...safeArgs);
    logger.emit(SeverityNumber.INFO, msg, ...safeArgs);
  },
  error: (msg: unknown, ...args: unknown[]) => {
    if (typeof msg !== "string") {
      msg = JSON.stringify(msg);
    }
    const safeArgs = args.map((arg) =>
      typeof arg === "string" ? arg : JSON.stringify(arg)
    );
    localLogger.error(msg, ...safeArgs);
    logger.emit(SeverityNumber.ERROR, msg, ...safeArgs);
  },
  warn: (msg: unknown, ...args: unknown[]) => {
    if (typeof msg !== "string") {
      msg = JSON.stringify(msg);
    }
    const safeArgs = args.map((arg) =>
      typeof arg === "string" ? arg : JSON.stringify(arg)
    );
    localLogger.warn(msg, ...safeArgs);
    logger.emit(SeverityNumber.WARN, msg, ...safeArgs);
  },
  debug: (msg: unknown, ...args: unknown[]) => {
    if (typeof msg !== "string") {
      msg = JSON.stringify(msg);
    }
    const safeArgs = args.map((arg) =>
      typeof arg === "string" ? arg : JSON.stringify(arg)
    );
    localLogger.debug(msg, ...safeArgs);
    logger.emit(SeverityNumber.DEBUG, msg, ...safeArgs);
  },
};
