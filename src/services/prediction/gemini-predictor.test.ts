import { describe, expect, test } from "bun:test";
import { GeminiError, type GeminiHttp } from "../gemini.client";
import { createGeminiPredictor, DEFAULT_PREDICTION_MODEL } from "./gemini-predictor";
import { PREDICTION_SCHEMA } from "./prompt";

const KEY = "secret-key-9";

function http(respond: () => Promise<{ data: unknown }>) {
  const calls: { url: string; body: { contents: { parts: unknown }[]; generationConfig: unknown }; config: { headers: Record<string, string>; timeout: number } }[] = [];
  const client: GeminiHttp = {
    post: async <T>(url: string, body: unknown, config: { headers: Record<string, string>; timeout: number }) => {
      calls.push({ url, body: body as (typeof calls)[number]["body"], config });
      return (await respond()) as { data: T };
    },
  };
  return { client, calls };
}
const reply = (text: string) => async () => ({ data: { candidates: [{ content: { parts: [{ text }] } }] } });

describe("createGeminiPredictor", () => {
  test("default model is gemini-pro-latest", () => {
    expect(DEFAULT_PREDICTION_MODEL).toBe("gemini-pro-latest");
  });

  test("sends prompt, schema, temperature 0.2 and a 90 s timeout; parses JSON", async () => {
    const { client, calls } = http(reply('{"round":1}'));
    const predictor = createGeminiPredictor({ apiKey: KEY, model: "gemini-pro-latest", http: client });
    expect(await predictor.predict("PROMPT")).toEqual({ round: 1 });
    expect(calls[0].url).toContain("/models/gemini-pro-latest:generateContent");
    expect(calls[0].body.contents[0].parts).toEqual([{ text: "PROMPT" }]);
    expect(calls[0].body.generationConfig).toEqual({ responseMimeType: "application/json", responseSchema: PREDICTION_SCHEMA, temperature: 0.2 });
    expect(calls[0].config.timeout).toBe(90_000);
  });

  test("invalid JSON is a non-retryable GeminiError without the key", async () => {
    const { client } = http(reply("not json"));
    const predictor = createGeminiPredictor({ apiKey: KEY, model: "m", http: client });
    const error = (await predictor.predict("P").catch((caught: unknown) => caught)) as GeminiError;
    expect(error).toBeInstanceOf(GeminiError);
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain(KEY);
  });
});
