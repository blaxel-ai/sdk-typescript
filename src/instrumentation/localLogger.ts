import pino from "pino";
import { env } from "../common/env.js";

const loggerConfiguration = {
  level: env.LOG_LEVEL || "info",
  transport: {
    target: "pino-pretty",
    options: {
      colorizeObjects: false,
      translateTime: false,
      hideObject: false,
      messageFormat: "\x1B[37m{msg}",
      ignore: "pid,hostname,time",
    },
  },
};

const localLogger = pino(loggerConfiguration);

export default localLogger;
