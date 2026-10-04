import { APICallError } from "ai";

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

/** Our own deadline (the `timeout` option) or an abort: the call never finished */
function isAbort(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Map any error of an AI SDK call to a GeminiError. Only the status code is used: the original error holds the
 * request (with the key). A 2xx status means the answer broke off while it was read: retryable like no answer.
 */
export function toGeminiError(error: unknown): GeminiError {
  if (error instanceof GeminiError) return error;
  if (APICallError.isInstance(error)) {
    const status = error.statusCode !== undefined && error.statusCode >= 300 ? error.statusCode : undefined;
    if (!status) return new GeminiError(UNREACHABLE, true);
    return new GeminiError(`Gemini-verzoek mislukt (HTTP ${status})`, status === 429 || status >= 500, status);
  }
  if (isAbort(error)) return new GeminiError(UNREACHABLE, true);
  return new GeminiError("Gemini gaf geen geldig antwoord", false);
}
