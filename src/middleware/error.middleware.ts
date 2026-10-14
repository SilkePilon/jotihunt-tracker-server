import { NextFunction, Request, Response } from "express";
import { logger } from "../logger";
import { isDatabaseUnavailable } from "../utils/database-errors";

export { isDatabaseUnavailable };

/** Fallback error handler (Express 5 forwards rejected promises from async handlers here). */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  logger.error(`Unhandled error on ${req.method} ${req.originalUrl}`, err);
  if (res.headersSent) return;
  if (isDatabaseUnavailable(err)) {
    res.setHeader("Retry-After", "5");
    return res.status(503).json({ message: "Database niet bereikbaar" });
  }
  const { status = 500, message } = (err ?? {}) as { status?: number; message?: string };
  res.status(status).json({ message: status >= 500 ? "Internal server error" : message });
}
