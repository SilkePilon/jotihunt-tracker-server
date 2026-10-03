import { NextFunction, Request, Response } from "express";
import { logger } from "../logger";

/**
 * The database can not be reached right now (server down, network, connection pool closed, or mongoose gave up
 * buffering a query while disconnected). Answered with 503 so clients retry instead of treating it as a bug.
 */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (/^Mongo(ose)?(ServerSelection|Network|NetworkTimeout|NotConnected|Topology(Closed)?)Error$/.test(error.name)) return true;
  if (error.name === "MongoPoolClearedError" || error.name === "MongoPoolClosedError") return true;
  return /buffering timed out|client was closed|Topology is closed/i.test(error.message);
}

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
