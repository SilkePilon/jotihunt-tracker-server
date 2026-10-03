import { NextFunction, Request, Response } from "express";

export interface FailureLimitOptions {
  /** Window in which failures are counted */
  windowMs: number;
  /** Failures allowed per key within the window; the next request gets a 429 */
  maxFailures: number;
  /** Responses with this status count as a failure */
  failureStatus: number;
  key: (req: Request) => string;
  now?: () => number;
}

/**
 * Small in-memory limiter for brute-force protection: counts failed responses per key and answers 429
 * once a key has too many failures in the window. A successful response clears the key. In memory is
 * enough for a single server process.
 */
export function limitFailures({ windowMs, maxFailures, failureStatus, key, now = Date.now }: FailureLimitOptions) {
  const failures = new Map<string, { count: number; resetAt: number }>();

  function prune(at: number) {
    for (const [entry, value] of failures) if (value.resetAt <= at) failures.delete(entry);
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const at = now();
    prune(at);
    const id = key(req);
    const entry = failures.get(id);
    if (entry && entry.count >= maxFailures) {
      res.setHeader("Retry-After", String(Math.ceil((entry.resetAt - at) / 1000)));
      return res.status(429).json({ message: "Te veel mislukte pogingen, probeer het later opnieuw." });
    }

    res.on("finish", () => {
      if (res.statusCode === failureStatus) {
        const current = failures.get(id);
        if (current && current.resetAt > now()) current.count++;
        else failures.set(id, { count: 1, resetAt: now() + windowMs });
      } else if (res.statusCode < 400) {
        failures.delete(id);
      }
    });
    next();
  };
}
