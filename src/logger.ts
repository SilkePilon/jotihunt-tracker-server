import winston from "winston";

export const debug = process.env.DEBUG === "true";

const SPLAT = Symbol.for("splat");

interface AxiosLikeError extends Error {
  isAxiosError: true;
  code?: string;
  config?: { method?: string; url?: string; baseURL?: string };
  response?: { status?: number };
}

function isAxiosError(error: Error): error is AxiosLikeError {
  return (error as Partial<AxiosLikeError>).isAxiosError === true;
}

/**
 * Turn errors into readable log fields. Winston serializes an Error passed as the message (node-cron does this) as
 * `"message":{}`, and an Error passed as meta has all its own fields copied in: for axios errors that is the whole
 * request, response and config (tens of KB per line, including request headers). Errors keep message and stack;
 * axios errors only message, method, url and status.
 */
export const errorDetails = winston.format((info) => {
  let error: Error | undefined;
  if (info.message instanceof Error) {
    error = info.message;
    info.message = error.message;
  } else {
    const meta = (info as { [SPLAT]?: unknown[] })[SPLAT]?.[0];
    // Winston already appended meta.message to the message
    if (meta instanceof Error) error = meta;
  }
  if (!error) return info;

  for (const key of Object.keys(error)) if (key !== "message") delete info[key];
  // Winston also copies the (non-enumerable) cause, e.g. the whole socket error
  delete info.cause;
  if (isAxiosError(error)) {
    delete info.stack;
    const { method, url, baseURL } = error.config ?? {};
    info.method = method?.toUpperCase();
    info.url = url && baseURL && !/^https?:/.test(url) ? `${baseURL.replace(/\/$/, "")}/${url.replace(/^\//, "")}` : url;
    info.status = error.response?.status;
    if (typeof error.code === "string") info.code = error.code;
  } else {
    info.stack = error.stack;
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number") info.code = code;
    if (error.cause !== undefined) info.cause = error.cause instanceof Error ? error.cause.message : String(error.cause);
  }
  return info;
});

// Setup logging with Winston. The log files are rotated so a long event can never fill the disk.
const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;
const MAX_LOG_FILES = 5;

export const logger = winston.createLogger({
  level: debug ? "debug" : "info",
  format: winston.format.combine(errorDetails(), winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.colorize(),
        winston.format.simple(),
        winston.format.printf((info) => `${info.timestamp} - ${info.level}: ${info.message}`),
      ),
    }),
    new winston.transports.File({ filename: "error.log", level: "error", maxsize: MAX_LOG_FILE_BYTES, maxFiles: MAX_LOG_FILES, tailable: true }),
    new winston.transports.File({ filename: "combined.log", maxsize: MAX_LOG_FILE_BYTES, maxFiles: MAX_LOG_FILES, tailable: true }),
  ],
});
