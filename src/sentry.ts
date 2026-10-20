import * as Sentry from "@sentry/bun";
import type { BunOptions } from "@sentry/bun";
import { isDatabaseUnavailable } from "./utils/database-errors";

/**
 * Sentry options from the environment, or null when no SENTRY_DSN is set (tests, local dev and test stacks send nothing).
 * Errors only: no tracing, and none of the request data Sentry v11 collects by default (bodies hold GPS positions,
 * AI calls hold images and hint text). Access-log lines are kept out of Sentry Logs (see dropAccessLogs in logger.ts);
 * beforeSendLog drops any that still get through.
 */
export function sentryOptions(env: NodeJS.ProcessEnv = process.env): BunOptions | null {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return null;
  return {
    dsn,
    environment: env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV || "development",
    release: env.SENTRY_RELEASE?.trim() || undefined,
    dataCollection: {
      userInfo: false,
      httpBodies: [],
      urlQueryParams: false,
      cookies: false,
      httpHeaders: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
    },
    beforeSendLog: (log) => (isAccessLog(log.attributes ?? {}) ? null : log),
    // Defence in depth in case the SDK attaches request data (Bun normally has no per-request scope)
    beforeSend: (event) => {
      if (event.request?.url) event.request.url = redactUrl(event.request.url);
      if (event.transaction) event.transaction = event.transaction.replace(/^([A-Z]+ )?(\/.*)$/, (_, method = "", path) => method + redactPath(path));
      return event;
    },
  };
}

/** A URL with its path redacted and no query string; scheme and host are kept for absolute URLs, bare paths are just redacted. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${redactPath(parsed.pathname)}`;
  } catch {
    return redactPath(url);
  }
}

/**
 * True for an express-winston access-log line: it carries the request (headers with the client IP, url with query
 * string and tokens) under meta.req, or under req/res with other field settings.
 */
export function isAccessLog(fields: Record<string, unknown>): boolean {
  const meta = fields.meta as { req?: unknown; res?: unknown } | undefined;
  return "req" in fields || "res" in fields || (typeof meta === "object" && meta !== null && ("req" in meta || "res" in meta));
}

// Paths whose segment after the prefix is a secret: recovery links, invite codes and QR login codes
const SECRET_SEGMENTS: [RegExp, string][] = [
  [/^\/herstel\/[^/]+/, "/herstel/:token"],
  [/^\/invites\/[^/]+/, "/invites/:code"],
  [/^\/auth\/qr\/scan\/[^/]+/, "/auth/qr/scan/:code"],
];

/** A request path safe to log and tag: no query string, no secret tokens or codes, ObjectIds as :id. */
export function redactPath(path: string): string {
  let redacted = path.split("?")[0];
  for (const [pattern, replacement] of SECRET_SEGMENTS) redacted = redacted.replace(pattern, replacement);
  return redacted.replace(/\/[0-9a-f]{24}(?=\/|$)/gi, "/:id");
}

let enabled = false;

/** Start Sentry when configured (runs from src/instrument.ts, preloaded before anything else). */
export function initSentry(env: NodeJS.ProcessEnv = process.env): boolean {
  const options = sentryOptions(env);
  if (!options) return false;
  Sentry.init(options);
  enabled = true;
  return true;
}

export function isSentryEnabled(): boolean {
  return enabled;
}

/** Groups repeats of one error for the throttle: where it happened, its type and its message (numbers ignored). */
export function issueKey(error: unknown, context = ""): string {
  const [type, message] = error instanceof Error ? [error.name, error.message] : [typeof error, String(error)];
  return `${context}|${type}|${message.replace(/\d+(\.\d+)?/g, "#")}`.slice(0, 300);
}

/** True when the key was not sent in the last windowMs. Keys are forgotten after their window. */
export function createIssueThrottle(windowMs: number, now: () => number = Date.now): (key: string) => boolean {
  const lastSent = new Map<string, number>();
  return (key) => {
    const time = now();
    for (const [seen, at] of lastSent) if (time - at > windowMs) lastSent.delete(seen);
    if (lastSent.has(key)) return false;
    lastSent.set(key, time);
    return true;
  };
}

export type Capture = (
  error: unknown,
  hint: { tags?: Record<string, string>; extra?: Record<string, unknown>; user?: { id: string; username?: string } },
) => unknown;

// Crons run every 10 seconds: a broken upstream would otherwise send 8640 events a day (the free plan has 5000 a month)
const allowIssue = createIssueThrottle(10 * 60 * 1000);

// Errors captureThrottled already decided on (sent or throttled), so a later log line of the same error is skipped
const handled = new WeakSet<object>();

/** True when captureThrottled already saw this error object. */
export function wasHandled(error: unknown): boolean {
  return typeof error === "object" && error !== null && handled.has(error);
}

/** Send an error to Sentry, at most once per 10 minutes per issueKey. */
export function captureThrottled(error: unknown, hint: Parameters<Capture>[1], context = "", capture: Capture = Sentry.captureException) {
  if (typeof error === "object" && error !== null) handled.add(error);
  if (!allowIssue(issueKey(error, context))) return;
  capture(error, hint);
}

/** Wait (bounded) until queued events are sent, e.g. before the process exits. */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (enabled) await Sentry.flush(timeoutMs);
}

/** 5xx answers are bugs worth an issue; a database outage is not (503, every request would report it). */
export function shouldReportRequestError(error: unknown, status: number): boolean {
  return status >= 500 && !isDatabaseUnavailable(error);
}

/**
 * Report a failed request with its route and user, throttled like crons (a broken endpoint polled by every hunter).
 * Context goes on the event (Bun has no per-request scope).
 */
export function reportRequestError(
  error: unknown,
  req: { method: string; originalUrl: string; user?: { _id: unknown; name?: string } | null },
  capture: Capture = Sentry.captureException,
) {
  const hint: Parameters<Capture>[1] = { tags: { route: `${req.method} ${redactPath(req.originalUrl)}` } };
  if (req.user) hint.user = { id: String(req.user._id), username: req.user.name };
  captureThrottled(error, hint, "request", capture);
}

/** Wrap a cron job: a thrown error is reported (throttled) with the job name, then rethrown for node-cron's own log. */
export function reportCronErrors<A extends unknown[]>(name: string, job: (...args: A) => unknown, capture: Capture = Sentry.captureException) {
  return async (...args: A) => {
    try {
      return await job(...args);
    } catch (error) {
      captureThrottled(error, { tags: { cron: name } }, `cron:${name}`, capture);
      throw error;
    }
  };
}
