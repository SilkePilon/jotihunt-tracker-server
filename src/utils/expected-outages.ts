/**
 * Failures of external services we expect during an event and cannot fix: the Jotihunt API down or rate limited,
 * Gemini or ORS rate limits, quota or bad answers. Every service wraps its raw errors in one of these, so anything
 * else (TypeError, MongoServerError, ...) is a bug. Matched by name: importing the services here would be a cycle.
 */
const EXPECTED_OUTAGES = new Set(["JotihuntApiError", "JotihuntPausedError", "GeminiError", "RoutingUnavailableError", "InvalidPredictionError"]);

export function isExpectedOutage(error: unknown): boolean {
  return error instanceof Error && EXPECTED_OUTAGES.has(error.name);
}
