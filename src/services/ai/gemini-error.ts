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

/** The answer arrived but could not be used; asking again would give the same */
export const invalidAnswer = () => new GeminiError(INVALID_ANSWER, false);

/** Our own deadline (the `timeout` option) or an abort: the call never finished */
function isAbort(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/** A network failure the SDK did not wrap in an APICallError: fetch throws a TypeError, a socket/DNS/TLS error has a string `code` */
function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError || typeof (error as { code?: unknown } | null)?.code === "string";
}

/**
 * Map any error of an AI SDK call to a GeminiError. The original message is never copied: the error holds the
 * request (with the key). A RetryError is mapped by its last error.
 * - API call error without a status: Gemini was not reached (retryable).
 * - API call error with a 2xx status: the answer broke off halfway when the SDK calls it retryable (unreachable,
 *   retryable); otherwise the answer could not be read (invalid, not retryable).
 * - API call error with any other status: a failed request, retryable when 429 or 5xx.
 * - Timeout, abort, or a network error outside an API call error: Gemini was not reached (retryable).
 * - Anything else, such as the SDK's output errors: an invalid answer (not retryable).
 */
export function toGeminiError(error: unknown): GeminiError {
  if (error instanceof GeminiError) return error;
  if (RetryError.isInstance(error)) return toGeminiError(error.lastError);
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    if (status === undefined) return new GeminiError(UNREACHABLE, true);
    if (status < 300) return error.isRetryable ? new GeminiError(UNREACHABLE, true) : invalidAnswer();
    return new GeminiError(`Gemini-verzoek mislukt (HTTP ${status})`, status === 429 || status >= 500, status);
  }
  if (isAbort(error) || isNetworkError(error)) return new GeminiError(UNREACHABLE, true);
  return invalidAnswer();
}
