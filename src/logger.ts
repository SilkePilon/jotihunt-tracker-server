import * as Sentry from "@sentry/bun";
import winston from "winston";
import Transport from "winston-transport";
import { captureThrottled, isAccessLog, isSentryEnabled, wasHandled, type Capture } from "./sentry";
import { isDatabaseUnavailable } from "./utils/database-errors";
import { isExpectedOutage } from "./utils/expected-outages";

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

/** errorDetails keeps the original Error under this key, for the Sentry transport (the info fields are flattened). */
export const ORIGINAL_ERROR = Symbol("originalError");

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
  (info as { [ORIGINAL_ERROR]?: Error })[ORIGINAL_ERROR] = error;

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

/**
 * Turns `logger.error("...", error)` into a Sentry issue (most crons and services catch and log instead of throwing).
 * Errors the request handler or a cron wrapper already handled are skipped. Database outages and expected outages of
 * external services (Jotihunt API, Gemini, ORS) are not issues: during an outage every cron run would log one.
 * Repeats are throttled.
 */
export function createSentryErrorTransport(capture: Capture = Sentry.captureException) {
  return new (class extends Transport {
    log(info: winston.Logform.TransformableInfo, next: () => void) {
      const error = (info as { [ORIGINAL_ERROR]?: Error })[ORIGINAL_ERROR];
      if (info.level === "error" && error && !wasHandled(error) && !isDatabaseUnavailable(error) && !isExpectedOutage(error)) {
        captureThrottled(error, { extra: { log: String(info.message) } }, "log", capture);
      }
      next();
    }
  })({ level: "error" });
}

/**
 * Keeps express-winston access-log lines out of a transport: they carry the request (headers with the client IP,
 * the url with query string and tokens). Used on the Sentry Logs transport; the log files keep them.
 */
export const dropAccessLogs = winston.format((info) => (isAccessLog(info) ? false : info));

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
        winston.format.printf((info) => `${info.timestamp} - ${info.level}: ${info.message}`),
      ),
    }),
    new winston.transports.File({ filename: "error.log", level: "error", maxsize: MAX_LOG_FILE_BYTES, maxFiles: MAX_LOG_FILES, tailable: true }),
    new winston.transports.File({ filename: "combined.log", maxsize: MAX_LOG_FILE_BYTES, maxFiles: MAX_LOG_FILES, tailable: true }),
  ],
});

// Sentry (when SENTRY_DSN is set): logged errors become issues, warnings and errors (not access logs) also go to Sentry Logs for context
if (isSentryEnabled()) {
  logger.add(createSentryErrorTransport());
  const SentryLogs = Sentry.createSentryWinstonTransport(Transport, { levels: ["error", "warn"] });
  logger.add(new SentryLogs({ format: dropAccessLogs() }));
}
