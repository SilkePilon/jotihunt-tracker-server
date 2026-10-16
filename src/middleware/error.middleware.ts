import { NextFunction, Request, Response } from "express";
import { logger } from "../logger";
import { redactPath, reportRequestError, shouldReportRequestError } from "../sentry";
import { isDatabaseUnavailable } from "../utils/database-errors";

/** Fallback error handler (Express 5 forwards rejected promises from async handlers here). */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const { status = 500, message } = (err ?? {}) as { status?: number; message?: string };
  // Before the log line: captureThrottled marks the error (also when throttled), so the logger's Sentry transport skips it
  if (shouldReportRequestError(err, status)) reportRequestError(err, req);
  // Path only, without secrets: query strings and some paths hold tokens, and the log line also goes to Sentry Logs.
  // Client errors (4xx, e.g. malformed JSON) are warnings: logger.error would make them Sentry issues.
  const line = `Unhandled error on ${req.method} ${redactPath(req.originalUrl)}`;
  if (status < 500 && !isDatabaseUnavailable(err)) logger.warn(line, err);
  else logger.error(line, err);
  if (res.headersSent) return;
  if (isDatabaseUnavailable(err)) {
    res.setHeader("Retry-After", "5");
    return res.status(503).json({ message: "Database niet bereikbaar" });
  }
  res.status(status).json({ message: status >= 500 ? "Internal server error" : message });
}
