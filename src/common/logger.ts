import { Logger, SeverityNumber } from "@opentelemetry/api-logs";
import localLogger from "../instrumentation/localLogger.js";
import { telemetryManager } from "../instrumentation/telemetryManager.js";

export const logger = {
  async getLogger(): Promise<Logger> {
    return await telemetryManager.getLogger();
  },

  asyncEmit: async (severityNumber: SeverityNumber, msg: string) => {
    const loggerInstance = await logger.getLogger();
    if (typeof msg !== "string") {
      msg = JSON.stringify(msg);
    }

    loggerInstance.emit({
      severityNumber: severityNumber,
      body: msg,
    });
  },
  emit: (severityNumber: SeverityNumber, msg: string) => {
    logger.asyncEmit(severityNumber, msg).catch((err) => {
      console.error(err);
    });
  },
  formatMessage: (msg: unknown, ...args: unknown[]): string => {
    const safeArgs = args.map((arg) =>
      typeof arg === "string" ? arg : JSON.stringify(arg)
    );
    let message = msg as string;
    for (const arg of safeArgs) {
      message += ` ${arg}`;
    }
    return message;
  },
  info: (msg: unknown, ...args: unknown[]) => {
    if (typeof msg !== "string") {
      msg = JSON.stringify(msg);
    }
    const message: string = logger.formatMessage(msg, ...args);
    localLogger.info(message);
    logger.emit(SeverityNumber.INFO, message);
  },
  error: (msg: unknown, ...args: unknown[]) => {
    if (typeof msg !== "string") {
      msg = JSON.stringify(msg);
    }
    const message: string = logger.formatMessage(msg, ...args);
    localLogger.error(message);
    logger.emit(SeverityNumber.ERROR, message);
  },
  warn: (msg: unknown, ...args: unknown[]) => {
    if (typeof msg !== "string") {
      msg = JSON.stringify(msg);
    }
    const message: string = logger.formatMessage(msg, ...args);
    localLogger.warn(message);
    logger.emit(SeverityNumber.WARN, message);
  },
  debug: (msg: unknown, ...args: unknown[]) => {
    if (typeof msg !== "string") {
      msg = JSON.stringify(msg);
    }
    const message: string = logger.formatMessage(msg, ...args);
    localLogger.debug(message);
    logger.emit(SeverityNumber.DEBUG, message);
  },
};
