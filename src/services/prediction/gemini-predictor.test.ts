import { describe, expect, test } from "bun:test";
import { APICallError } from "ai";
import { geminiReply, localGoogle, mockModel, TEST_API_KEY } from "../../test/ai";
import { GeminiError } from "../gemini.client";
import { createGeminiPredictor } from "./gemini-predictor";
import { PREDICTION_SCHEMA } from "./prompt";

const caught = async (promise: Promise<unknown>) => (await promise.catch((error: unknown) => error)) as GeminiError;

describe("createGeminiPredictor", () => {
  test("sends the prompt with the schema at temperature 0.2 and returns the parsed JSON", async () => {
    const model = mockModel(() => '{"round":1}');
    expect(await createGeminiPredictor({ model }).predict("PROMPT")).toEqual({ round: 1 });
    const [call] = model.doGenerateCalls;
    expect(call.prompt).toEqual([{ role: "user", content: [{ type: "text", text: "PROMPT" }] }]);
    expect<unknown>(call.responseFormat).toEqual({ type: "json", schema: PREDICTION_SCHEMA });
    expect(call.temperature).toBe(0.2);
    expect(call.abortSignal).toBeInstanceOf(AbortSignal);
  });

  test("invalid JSON is a non-retryable GeminiError without the key", async () => {
    const error = await caught(createGeminiPredictor({ model: mockModel(() => "not json") }).predict("P"));
    expect(error).toBeInstanceOf(GeminiError);
    expect(error.retryable).toBe(false);
    expect(error.message).toBe("Gemini gaf geen geldig antwoord");
    expect(error.message).not.toContain(TEST_API_KEY);
  });

  test("429 keeps its status (the service pauses on it)", async () => {
    const model = mockModel(() => {
      throw new APICallError({ message: TEST_API_KEY, url: "u", requestBodyValues: {}, statusCode: 429, isRetryable: true });
    });
    const error = await caught(createGeminiPredictor({ model }).predict("P"));
    expect(error).toBeInstanceOf(GeminiError);
    expect(error.status).toBe(429);
    expect(error.retryable).toBe(true);
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  test("the deadline makes a hanging call a retryable GeminiError", async () => {
    const google = localGoogle(() => new Promise<Response>(() => {}));
    try {
      const started = Date.now();
      const error = await caught(createGeminiPredictor({ model: google.model("m"), timeoutMs: 300 }).predict("P"));
      expect(Date.now() - started).toBeLessThan(3000);
      expect(error).toBeInstanceOf(GeminiError);
      expect(error.retryable).toBe(true);
      expect(error.status).toBeUndefined();
    } finally {
      google.stop();
    }
  });
});

describe("createGeminiPredictor over the wire (real Google provider, local server)", () => {
  test("posts the schema as responseJsonSchema; an empty answer is not retryable", async () => {
    let body: unknown;
    let reply = () => geminiReply('{"round":2}');
    const google = localGoogle(async (request) => {
      body = await request.json();
      return reply();
    });
    try {
      const predictor = createGeminiPredictor({ model: google.model("gemini-pro-latest") });
      expect(await predictor.predict("PROMPT")).toEqual({ round: 2 });
      expect(body).toEqual({
        generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseJsonSchema: PREDICTION_SCHEMA },
        contents: [{ role: "user", parts: [{ text: "PROMPT" }] }],
      });

      reply = () => Response.json({});
      const error = await caught(predictor.predict("PROMPT"));
      expect(error).toBeInstanceOf(GeminiError);
      expect(error.retryable).toBe(false);
    } finally {
      google.stop();
    }
  });
});
