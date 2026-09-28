import { describe, expect, test } from "bun:test";
import { createGeminiClient, GeminiError, STICKER_PROMPT, type GeminiHttp } from "./gemini.client";

const API_KEY = "test-key-123";

function fakeHttp(respond: () => Promise<{ data: unknown }>) {
  const calls: { url: string; body: unknown; config: { headers: Record<string, string>; timeout: number } }[] = [];
  const http: GeminiHttp = {
    post: async <T>(url: string, body: unknown, config: { headers: Record<string, string>; timeout: number }) => {
      calls.push({ url, body, config });
      return (await respond()) as { data: T };
    },
  };
  return { http, calls };
}

const answer = (text: string) => async () => ({ data: { candidates: [{ content: { parts: [{ text }] } }] } });
const httpError = (status: number) => async () => {
  throw Object.assign(new Error(`Request failed with status code ${status}`), { response: { status }, config: { headers: { "x-goog-api-key": API_KEY } } });
};

async function readError(promise: Promise<unknown>): Promise<GeminiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GeminiError);
    expect((error as Error).message).not.toContain(API_KEY);
    return error as GeminiError;
  }
  throw new Error("Expected a GeminiError");
}

describe("createGeminiClient.readSticker", () => {
  test("posts the prompt and the image to generateContent with the key in a header", async () => {
    const { http, calls } = fakeHttp(answer('{"code":"GNcrZRZ","codeConfidence":0.95,"time":"11:17","timeConfidence":0.8}'));
    const client = createGeminiClient({ apiKey: API_KEY, model: "gemini-3.8-flash", http });
    await client.readSticker("BASE64", "image/jpeg");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect(call.url).not.toContain(API_KEY);
    expect(call.config).toEqual({ headers: { "x-goog-api-key": API_KEY }, timeout: 30_000 });
    expect(call.body).toEqual({
      contents: [{ parts: [{ text: STICKER_PROMPT }, { inline_data: { mime_type: "image/jpeg", data: "BASE64" } }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0 },
    });
  });

  test("the prompt explains the title, the case-sensitive code and the handwritten time", () => {
    expect(STICKER_PROMPT).toContain("JOTIHUNT");
    expect(STICKER_PROMPT).toMatch(/case-sensitive/i);
    expect(STICKER_PROMPT).toMatch(/handwritten/i);
    expect(STICKER_PROMPT).toContain('"codeConfidence"');
  });

  test("parses the answer, also when split over parts", async () => {
    const { http } = fakeHttp(async () => ({ data: { candidates: [{ content: { parts: [{ text: '{"code":"Gy3M8XI","codeConfidence":0.9,' }, { text: '"time":"5.53","timeConfidence":0.7}' }] } }] } }));
    const client = createGeminiClient({ apiKey: API_KEY, model: "m", http });
    expect(await client.readSticker("x", "image/jpeg")).toEqual({ code: "Gy3M8XI", codeConfidence: 0.9, time: "05:53", timeConfidence: 0.7 });
  });

  test("5xx and 429 are retryable", async () => {
    for (const status of [500, 503, 429]) {
      const client = createGeminiClient({ apiKey: API_KEY, model: "m", http: fakeHttp(httpError(status)).http });
      const error = await readError(client.readSticker("x", "image/jpeg"));
      expect(error.retryable).toBe(true);
      expect(error.status).toBe(status);
    }
  });

  test("4xx is not retryable", async () => {
    const client = createGeminiClient({ apiKey: API_KEY, model: "m", http: fakeHttp(httpError(400)).http });
    const error = await readError(client.readSticker("x", "image/jpeg"));
    expect(error.retryable).toBe(false);
    expect(error.status).toBe(400);
  });

  test("a network error (no response) is retryable", async () => {
    const client = createGeminiClient({
      apiKey: API_KEY,
      model: "m",
      http: fakeHttp(async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      }).http,
    });
    const error = await readError(client.readSticker("x", "image/jpeg"));
    expect(error.retryable).toBe(true);
    expect(error.status).toBeUndefined();
  });

  test("garbage or an empty answer is not retryable", async () => {
    for (const respond of [answer("Sorry, I can't read that."), async () => ({ data: {} })]) {
      const client = createGeminiClient({ apiKey: API_KEY, model: "m", http: fakeHttp(respond).http });
      const error = await readError(client.readSticker("x", "image/jpeg"));
      expect(error.retryable).toBe(false);
    }
  });
});
