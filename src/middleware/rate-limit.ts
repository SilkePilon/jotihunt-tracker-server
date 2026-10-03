import { NextFunction, Request, Response } from "express";

/** Default cap on tracked keys per limiter, so unique keys (e.g. random e-mail addresses) can not grow memory. */
const DEFAULT_MAX_KEYS = 10_000;

/** Insert `key`, evicting the oldest entries (Map keeps insertion order) when the map is full. */
function setCapped<V>(map: Map<string, V>, key: string, value: V, maxKeys: number) {
  if (!map.has(key)) {
    for (const oldest of map.keys()) {
      if (map.size < maxKeys) break;
      map.delete(oldest);
    }
  }
  map.set(key, value);
}

export interface FailureLimitOptions {
  /** Window in which failures are counted */
  windowMs: number;
  /** Failures allowed per key within the window; the next request gets a 429 */
  maxFailures: number;
  /** Responses with this status count as a failure */
  failureStatus: number;
  key: (req: Request) => string;
  /** Whether a successful response clears the key (default true) */
  resetOnSuccess?: boolean;
  /** Most keys kept; the oldest are dropped first (default 10 000) */
  maxKeys?: number;
  now?: () => number;
}

/**
 * Small in-memory limiter for brute-force protection: counts failed responses per key and answers 429
 * once a key has too many failures in the window. A successful response clears the key. In memory is
 * enough for a single server process.
 */
export function limitFailures({
  windowMs,
  maxFailures,
  failureStatus,
  key,
  resetOnSuccess = true,
  maxKeys = DEFAULT_MAX_KEYS,
  now = Date.now,
}: FailureLimitOptions) {
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
        else setCapped(failures, id, { count: 1, resetAt: now() + windowMs }, maxKeys);
      } else if (res.statusCode < 400 && resetOnSuccess) {
        failures.delete(id);
      }
    });
    next();
  };
}

export interface RateLimitOptions {
  /** Window in which requests are counted */
  windowMs: number;
  /** Requests allowed per key within the window; the next request gets a 429 */
  max: number;
  key: (req: Request) => string;
  /** Most keys kept; the oldest are dropped first (default 10 000) */
  maxKeys?: number;
  now?: () => number;
}

/** In-memory fixed-window limiter for writes: at most `max` requests per key per window, then 429. */
export function limitRate({ windowMs, max, key, maxKeys = DEFAULT_MAX_KEYS, now = Date.now }: RateLimitOptions) {
  const counts = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction) => {
    const at = now();
    const id = key(req);
    let entry = counts.get(id);
    if (!entry || entry.resetAt <= at) {
      counts.delete(id);
      entry = { count: 0, resetAt: at + windowMs };
      setCapped(counts, id, entry, maxKeys);
    }
    if (entry.count >= max) {
      res.setHeader("Retry-After", String(Math.ceil((entry.resetAt - at) / 1000)));
      return res.status(429).json({ message: "Te veel verzoeken achter elkaar, wacht even en probeer het opnieuw." });
    }
    entry.count++;
    next();
  };
}

/** Per signed-in user (after verifyToken): 30 writes per minute per route group, far above real use. */
export function limitUserWrites(max = 30, windowMs = 60_000) {
  return limitRate({ windowMs, max, key: (req) => req.user?._id.toString() ?? req.ip ?? "" });
}
