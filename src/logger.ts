import pino from "pino";
import { config } from "./config";

const baseOptions = {
  level: config.logLevel
};

const logFile = process.env.COURIER_LOG_FILE?.trim() || "";

function createLogger() {
  if (config.env !== "development") {
    if (!logFile) {
      return pino(baseOptions);
    }
    return pino(baseOptions, pino.destination({ dest: logFile, append: true, mkdir: true, sync: false }));
  }

  const prettyOptions: Record<string, string | boolean> = {
    colorize: !logFile && Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
  };
  if (logFile) {
    prettyOptions.destination = logFile;
    prettyOptions.append = true;
    prettyOptions.mkdir = true;
  }
  return pino({
    ...baseOptions,
    transport: {
      target: "pino-pretty",
      options: prettyOptions
    }
  });
}

export const logger = createLogger();
