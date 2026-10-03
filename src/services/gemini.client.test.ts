import { describe, expect, test } from "bun:test";
import axios from "axios";
import { createGeminiClient, generateJson, GeminiError, STICKER_PROMPT, type GeminiHttp, type GeminiRequestConfig } from "./gemini.client";

const API_KEY = "test-key-123";

function fakeHttp(respond: () => Promise<{ data: unknown }>) {
  const calls: { url: string; body: unknown; config: GeminiRequestConfig }[] = [];
  const http: GeminiHttp = {
    post: async <T>(url: string, body: unknown, config: GeminiRequestConfig) => {
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
    expect(call.config).toMatchObject({ headers: { "x-goog-api-key": API_KEY }, timeout: 30_000 });
    expect(call.config.signal).toBeInstanceOf(AbortSignal);
    expect(call.config.maxContentLength).toBeGreaterThan(0);
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
    expect(await client.readSticker("x", "image/jpeg")).toEqual({ code: "Gy3M8XI", codeConfidence: 0.9, time: "05:53", timeConfidence: 0.7, box: null });
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

describe("generateJson", () => {
  test("posts parts and generationConfig with the key header, returns the text", async () => {
    const { http, calls } = fakeHttp(answer('{"ok":true}'));
    const text = await generateJson({ http, apiKey: API_KEY, model: "m-1", parts: [{ text: "hi" }], generationConfig: { temperature: 0.2 }, timeoutMs: 5000 });
    expect(text).toBe('{"ok":true}');
    expect(calls[0].url).toContain("/models/m-1:generateContent");
    expect(calls[0].config).toMatchObject({ headers: { "x-goog-api-key": API_KEY }, timeout: 5000 });
    expect(calls[0].body).toEqual({ contents: [{ parts: [{ text: "hi" }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.2 } });
  });

  test("429 is retryable and hides the key", async () => {
    const { http } = fakeHttp(httpError(429));
    const error = await readError(generateJson({ http, apiKey: API_KEY, model: "m", parts: [], timeoutMs: 1 }));
    expect(error.retryable).toBe(true);
    expect(error.status).toBe(429);
  });
});

describe("generateJson deadlines", () => {
  test("an answer that broke off after a 2xx status (timeout while reading the body) is retryable", async () => {
    const { http } = fakeHttp(async () => {
      throw Object.assign(new Error("canceled"), { code: "ERR_CANCELED", response: { status: 200 } });
    });
    const error = await readError(generateJson({ http, apiKey: API_KEY, model: "m", parts: [], timeoutMs: 1 }));
    expect(error.retryable).toBe(true);
    expect(error.status).toBeUndefined();
    expect(error.message).toBe("Gemini niet bereikbaar");
  });

  test("a trickling answer is aborted after the total deadline (real axios)", async () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch() {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"candidates":['));
            timer = setInterval(() => {
              try {
                controller.enqueue(new TextEncoder().encode(" "));
              } catch {
                clearInterval(timer);
              }
            }, 50);
          },
          cancel() {
            clearInterval(timer);
          },
        });
        return new Response(stream, { headers: { "content-type": "application/json" } });
      },
    });
    try {
      const local: GeminiHttp = { post: (_url, body, config) => axios.post(`http://127.0.0.1:${server.port}/`, body, config) };
      const started = Date.now();
      const error = await readError(generateJson({ http: local, apiKey: API_KEY, model: "m", parts: [], timeoutMs: 400 }));
      expect(Date.now() - started).toBeLessThan(3000);
      expect(error.retryable).toBe(true);
    } finally {
      clearInterval(timer);
      server.stop(true);
    }
  });
});
