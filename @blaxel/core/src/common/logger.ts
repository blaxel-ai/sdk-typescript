interface LoggerInterface {
  info: (message: string) => void;
  debug: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}


/**
 * Stringify an object with a limited depth
 * @param obj The object to stringify
 * @param maxDepth Maximum depth (default: 1)
 * @param depth Current depth (internal use)
 */
export function stringify<T>(obj: T, maxDepth: number = 1, depth: number = 0): string {
  if (obj instanceof Error) return obj.stack || obj.message;
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
  const pairs = Object.entries(obj as Record<string, unknown>).map(([key, val]) =>
    `"${key}": ${stringify(val, maxDepth, depth + 1)}`
  );

  return `{${pairs.join(', ')}}`;
}


class Logger {
  private logger: LoggerInterface;

  constructor() {
    this.logger = console;
  }

  setLogger(logger: LoggerInterface) {
    this.logger = logger;
  }

  parseArgs(args: unknown[]) : string {
    return args.map((arg) => {
      if (arg instanceof Error) {
        return arg.stack ?? arg.message;
      }
      return arg;
    }).join(" ");
  }
  info(...message: unknown[]) {
    this.logger.info(this.parseArgs(message));
  }

  debug(...message: unknown[]) {
    this.logger.debug(this.parseArgs(message));
  }

  warn(...message: unknown[]) {
    this.logger.warn(this.parseArgs(message));
  }

  error(...message: unknown[]) {
    this.logger.error(this.parseArgs(message));
  }
}


const logger = new Logger();

export { logger };
