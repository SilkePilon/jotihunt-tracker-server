import * as Sentry from "@sentry/bun";
import type { BunOptions } from "@sentry/bun";
import { isDatabaseUnavailable } from "./utils/database-errors";

/**
 * Sentry options from the environment, or null when no SENTRY_DSN is set (tests, local dev, demo stacks send nothing).
 * Errors only: no tracing, and none of the request data Sentry v11 collects by default (bodies hold GPS positions,
 * AI calls hold hunt photos and hint text).
 */
export function sentryOptions(env: NodeJS.ProcessEnv = process.env): BunOptions | null {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return null;
  return {
    dsn,
    environment: env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV || "development",
    release: env.SENTRY_RELEASE?.trim() || undefined,
    tracesSampleRate: 0,
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
  };
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

/** Groups repeats of one error for the throttle: where it happened, its type and its message. */
export function issueKey(error: unknown, context = ""): string {
  if (error instanceof Error) return `${context}|${error.name}|${error.message}`.slice(0, 300);
  return `${context}|${typeof error}|${String(error)}`.slice(0, 300);
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

/** Send an error to Sentry, at most once per 10 minutes per issueKey. */
export function captureThrottled(error: unknown, hint: Parameters<Capture>[1], context = "", capture: Capture = Sentry.captureException) {
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

/** Report a failed request with its route and user. Context goes on the event (Bun has no per-request scope). */
export function reportRequestError(
  error: unknown,
  req: { method: string; originalUrl: string; user?: { _id: unknown; name?: string } | null },
  capture: Capture = Sentry.captureException,
) {
  const hint: Parameters<Capture>[1] = { tags: { route: `${req.method} ${req.originalUrl.split("?")[0]}` } };
  if (req.user) hint.user = { id: String(req.user._id), username: req.user.name };
  capture(error, hint);
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
