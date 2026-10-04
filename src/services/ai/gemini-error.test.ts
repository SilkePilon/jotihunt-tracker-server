import { describe, expect, test } from "bun:test";
import { APICallError, RetryError } from "ai";
import { GeminiError, toGeminiError } from "./gemini-error";

const KEY = "secret-key-9";
const apiError = (statusCode?: number) =>
  new APICallError({ message: `failed with ${KEY}`, url: `https://example.test/?key=${KEY}`, requestBodyValues: {}, statusCode, isRetryable: true });

describe("toGeminiError", () => {
  test("5xx and 429 are retryable and carry the status", () => {
    for (const status of [500, 503, 429]) {
      const error = toGeminiError(apiError(status));
      expect(error).toBeInstanceOf(GeminiError);
      expect(error.message).toBe(`Gemini-verzoek mislukt (HTTP ${status})`);
      expect(error.retryable).toBe(true);
      expect(error.status).toBe(status);
    }
  });

  test("4xx is not retryable", () => {
    const error = toGeminiError(apiError(400));
    expect(error.message).toBe("Gemini-verzoek mislukt (HTTP 400)");
    expect(error.retryable).toBe(false);
    expect(error.status).toBe(400);
  });

  test("no response (connection refused) is retryable without a status", () => {
    const error = toGeminiError(apiError(undefined));
    expect(error.message).toBe("Gemini niet bereikbaar");
    expect(error.retryable).toBe(true);
    expect(error.status).toBeUndefined();
  });

  test("a 2xx status on an API error is an invalid answer, not retryable", () => {
    const error = toGeminiError(apiError(200));
    expect(error.message).toBe("Gemini gaf geen geldig antwoord");
    expect(error.retryable).toBe(false);
    expect(error.status).toBeUndefined();
  });

  test("a RetryError is mapped by its last error", () => {
    const retryError = new RetryError({ message: `retries failed ${KEY}`, reason: "maxRetriesExceeded", errors: [apiError(503)] });
    const error = toGeminiError(retryError);
    expect(error.message).toBe("Gemini-verzoek mislukt (HTTP 503)");
    expect(error.message).not.toContain(KEY);
    expect(error.retryable).toBe(true);
    expect(error.status).toBe(503);
  });

  test("a timeout or abort is retryable", () => {
    for (const name of ["TimeoutError", "AbortError"]) {
      const error = toGeminiError(new DOMException("stopped", name));
      expect(error.message).toBe("Gemini niet bereikbaar");
      expect(error.retryable).toBe(true);
    }
  });

  test("anything else is an invalid answer, not retryable", () => {
    const error = toGeminiError(new Error(`could not parse ${KEY}`));
    expect(error.message).toBe("Gemini gaf geen geldig antwoord");
    expect(error.retryable).toBe(false);
  });

  test("never copies the original message (it may hold the key)", () => {
    for (const cause of [apiError(500), apiError(undefined), new Error(KEY)]) {
      expect(toGeminiError(cause).message).not.toContain(KEY);
    }
  });

  test("a GeminiError passes through unchanged", () => {
    const original = new GeminiError("x", false, 418);
    expect(toGeminiError(original)).toBe(original);
  });
});
