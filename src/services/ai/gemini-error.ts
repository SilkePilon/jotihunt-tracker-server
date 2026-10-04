import { APICallError, RetryError } from "ai";

/** Failure of a Gemini call. The (Dutch) message is shown to HQ; it never contains the API key or the raw error. */
export class GeminiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

const UNREACHABLE = "Gemini niet bereikbaar";
const INVALID_ANSWER = "Gemini gaf geen geldig antwoord";

/** Our own deadline (the `timeout` option) or an abort: the call never finished */
function isAbort(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Map any error of an AI SDK call to a GeminiError. Only the status code is used: the original error holds the
 * request (with the key). A RetryError is mapped by its last error. No status means Gemini was not reached
 * (retryable); a 2xx status means the response itself could not be read as a valid answer (not retryable);
 * any other status is a failed request, retryable when 429 or 5xx.
 */
export function toGeminiError(error: unknown): GeminiError {
  if (error instanceof GeminiError) return error;
  if (RetryError.isInstance(error)) return toGeminiError(error.lastError);
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    if (status === undefined) return new GeminiError(UNREACHABLE, true);
    if (status < 300) return new GeminiError(INVALID_ANSWER, false);
    return new GeminiError(`Gemini-verzoek mislukt (HTTP ${status})`, status === 429 || status >= 500, status);
  }
  if (isAbort(error)) return new GeminiError(UNREACHABLE, true);
  return new GeminiError(INVALID_ANSWER, false);
}
