import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";

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

/** One model step of a scripted stream: text, and/or tool calls (input as an object) */
export interface StreamStep {
  text?: string;
  toolCalls?: { id: string; name: string; input: unknown }[];
}

/**
 * A streaming model that answers step by step from `steps` (the last step repeats). Calls are in `doStreamCalls`
 * (prompt, tools, providerOptions).
 */
export function mockStreamModel(steps: StreamStep[]) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[Math.min(call++, steps.length - 1)];
      const parts: unknown[] = [{ type: "stream-start", warnings: [] }];
      if (step.text !== undefined) parts.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: step.text }, { type: "text-end", id: "t" });
      for (const toolCall of step.toolCalls ?? []) parts.push({ type: "tool-call", toolCallId: toolCall.id, toolName: toolCall.name, input: JSON.stringify(toolCall.input) });
      parts.push({ type: "finish", usage, finishReason: { unified: step.toolCalls?.length ? "tool-calls" : "stop", raw: undefined } });
      return { stream: convertArrayToReadableStream(parts as never[]) };
    },
  });
}
