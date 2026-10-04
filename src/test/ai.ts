import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/** A model that answers with the text `respond` returns (or throws what it throws). Calls are in `doGenerateCalls`. */
export function mockModel(respond: () => string | Promise<string>) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: await respond() }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage,
      warnings: [],
    }),
  });
}

export const TEST_API_KEY = "test-key-123";

/** The real Google provider pointed at a local server, to check what goes over the wire. Call stop() when done. */
export function localGoogle(handler: (request: Request) => Response | Promise<Response>): { model: (id: string) => LanguageModel; stop: () => void } {
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: handler });
  const google = createGoogleGenerativeAI({ apiKey: TEST_API_KEY, baseURL: `http://127.0.0.1:${server.port}/v1beta` });
  return { model: (id) => google(id), stop: () => server.stop(true) };
}

/** A generateContent answer whose text is split over `parts` */
export const geminiReply = (...parts: string[]) => Response.json({ candidates: [{ content: { role: "model", parts: parts.map((text) => ({ text })) }, finishReason: "STOP" }] });
