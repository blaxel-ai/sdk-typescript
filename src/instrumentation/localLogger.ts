
import pino from "pino";

const loggerConfiguration = {
  level: process.env.BL_LOG_LEVEL || "info",
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
