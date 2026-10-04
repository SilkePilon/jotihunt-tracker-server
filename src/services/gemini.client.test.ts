import { describe, expect, test } from "bun:test";
import { APICallError } from "ai";
import { geminiReply, localGoogle, mockModel, TEST_API_KEY } from "../test/ai";
import { createGeminiClient, GeminiError, STICKER_PROMPT, STICKER_TIMEOUT_MS } from "./gemini.client";

/** Valid base64: the SDK decodes the first bytes of a file part to detect its media type */
const IMAGE = "eA==";

const apiError = (statusCode?: number) => () => {
  throw new APICallError({ message: `failed ${TEST_API_KEY}`, url: "u", requestBodyValues: {}, statusCode, isRetryable: true });
};

async function readError(promise: Promise<unknown>): Promise<GeminiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GeminiError);
    expect((error as Error).message).not.toContain(TEST_API_KEY);
    return error as GeminiError;
  }
  throw new Error("Expected a GeminiError");
}

describe("createGeminiClient.readSticker", () => {
  test("sends the prompt and the image, asks for JSON at temperature 0 with a deadline", async () => {
    const model = mockModel(() => '{"code":"GNcrZRZ","codeConfidence":0.95,"time":"11:17","timeConfidence":0.8}');
    await createGeminiClient({ model }).readSticker("QkFTRTY0", "image/jpeg");
    expect(model.doGenerateCalls).toHaveLength(1);
    const [call] = model.doGenerateCalls;
    expect(call.prompt).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: STICKER_PROMPT },
          { type: "file", mediaType: "image/jpeg", data: { type: "data", data: "QkFTRTY0" } },
        ],
      },
    ]);
    expect(call.responseFormat).toEqual({ type: "json" });
    expect(call.temperature).toBe(0);
    expect(call.abortSignal).toBeInstanceOf(AbortSignal);
  });

  test("the prompt explains the title, the case-sensitive code and the handwritten time", () => {
    expect(STICKER_PROMPT).toContain("JOTIHUNT");
    expect(STICKER_PROMPT).toMatch(/case-sensitive/i);
    expect(STICKER_PROMPT).toMatch(/handwritten/i);
    expect(STICKER_PROMPT).toContain('"codeConfidence"');
  });

  test("parses and normalises the answer", async () => {
    const model = mockModel(() => '{"code":"Gy3M8XI","codeConfidence":0.9,"time":"5.53","timeConfidence":0.7,"box":[100,200,300,400]}');
    expect(await createGeminiClient({ model }).readSticker(IMAGE, "image/jpeg")).toEqual({
      code: "Gy3M8XI",
      codeConfidence: 0.9,
      time: "05:53",
      timeConfidence: 0.7,
      box: [100, 200, 300, 400],
    });
  });

  test("an answer inside ```json fences is still read", async () => {
    const model = mockModel(() => '```json\n{"code":"GNcrZRZ","codeConfidence":0.95,"time":"11:17","timeConfidence":0.8}\n```');
    expect(await createGeminiClient({ model }).readSticker(IMAGE, "image/jpeg")).toEqual({
      code: "GNcrZRZ",
      codeConfidence: 0.95,
      time: "11:17",
      timeConfidence: 0.8,
      box: null,
    });
  });

  test("the default deadline is 30 seconds", () => {
    expect(STICKER_TIMEOUT_MS).toBe(30_000);
  });

  test("5xx and 429 are retryable", async () => {
    for (const status of [500, 503, 429]) {
      const error = await readError(createGeminiClient({ model: mockModel(apiError(status)) }).readSticker(IMAGE, "image/jpeg"));
      expect(error.retryable).toBe(true);
      expect(error.status).toBe(status);
    }
  });

  test("4xx is not retryable", async () => {
    const error = await readError(createGeminiClient({ model: mockModel(apiError(400)) }).readSticker(IMAGE, "image/jpeg"));
    expect(error.retryable).toBe(false);
    expect(error.status).toBe(400);
  });

  test("a network error (no response) is retryable", async () => {
    const error = await readError(createGeminiClient({ model: mockModel(apiError(undefined)) }).readSticker(IMAGE, "image/jpeg"));
    expect(error.retryable).toBe(true);
    expect(error.status).toBeUndefined();
    expect(error.message).toBe("Gemini niet bereikbaar");
  });

  test("garbage or an empty answer is not retryable", async () => {
    for (const text of ["Sorry, I can't read that.", ""]) {
      const error = await readError(createGeminiClient({ model: mockModel(() => text) }).readSticker(IMAGE, "image/jpeg"));
      expect(error.retryable).toBe(false);
      expect(error.message).toBe("Gemini gaf geen geldig antwoord");
    }
  });

  test("the model is called once: retrying is the queue's job", async () => {
    const model = mockModel(apiError(503));
    await readError(createGeminiClient({ model }).readSticker(IMAGE, "image/jpeg"));
    expect(model.doGenerateCalls).toHaveLength(1);
  });
});

describe("createGeminiClient over the wire (real Google provider, local server)", () => {
  test("posts to generateContent with the key in a header, the image inline, and joins a split answer", async () => {
    let seen: { url: string; key: string | null; body: unknown } | undefined;
    const google = localGoogle(async (request) => {
      seen = { url: request.url, key: request.headers.get("x-goog-api-key"), body: await request.json() };
      return geminiReply('{"code":"Gy3M8XI","codeConfidence":0.9,', '"time":"5.53","timeConfidence":0.7}');
    });
    try {
      const reading = await createGeminiClient({ model: google.model("gemini-3.8-flash") }).readSticker("QkFTRTY0", "image/jpeg");
      expect(reading).toEqual({ code: "Gy3M8XI", codeConfidence: 0.9, time: "05:53", timeConfidence: 0.7, box: null });
      expect(seen!.url).toEndWith("/v1beta/models/gemini-3.8-flash:generateContent");
      expect(seen!.url).not.toContain(TEST_API_KEY);
      expect(seen!.key).toBe(TEST_API_KEY);
      expect(seen!.body).toEqual({
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
        contents: [{ role: "user", parts: [{ text: STICKER_PROMPT }, { inlineData: { mimeType: "image/jpeg", data: "QkFTRTY0" } }] }],
      });
    } finally {
      google.stop();
    }
  });

  test("an HTTP error keeps its status and hides the key", async () => {
    const google = localGoogle(() => Response.json({ error: { code: 503, message: "overloaded", status: "UNAVAILABLE" } }, { status: 503 }));
    try {
      const error = await readError(createGeminiClient({ model: google.model("m") }).readSticker(IMAGE, "image/jpeg"));
      expect(error.status).toBe(503);
      expect(error.retryable).toBe(true);
    } finally {
      google.stop();
    }
  });

  test("a trickling answer is aborted after the total deadline", async () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const google = localGoogle(() => {
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
    });
    try {
      const started = Date.now();
      const error = await readError(createGeminiClient({ model: google.model("m"), timeoutMs: 400 }).readSticker(IMAGE, "image/jpeg"));
      expect(Date.now() - started).toBeLessThan(3000);
      expect(error.retryable).toBe(true);
      expect(error.message).toBe("Gemini niet bereikbaar");
    } finally {
      clearInterval(timer);
      google.stop();
    }
  });
});
