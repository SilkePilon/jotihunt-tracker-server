import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { UIMessage } from "ai";
import { convertReadableStreamToArray, MockLanguageModelV4 } from "ai/test";
import mongoose from "mongoose";
import { Article } from "../../models/article.model";
import { HintCell, HintCellStatus } from "../../models/hint-cell.model";
import { mockModel, mockStreamModel, type StreamStep } from "../../test/ai";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../test/db";
import { streamIntelChat, type IntelChatModels } from "./agent";
import { clearItemImageCache } from "./item-images";
import { loadChat, saveChat } from "./store";
import { loadItemView } from "./tools/app-data";

const NOW = new Date("2026-10-17T12:05:00Z");
const CONTENT = '<div>Alpha: <img src="https://cdn.jotihunt.net/a.png" alt="alpha.png"></div>';
const question: UIMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "Los Alpha op" }] };

beforeAll(connectTestDb);
beforeEach(async () => {
  await clearTestDb();
  clearItemImageCache();
  await Article.create({ id: 10, title: "Hint 10", type: "hint", publishAt: NOW, content: CONTENT, contentHash: "h" });
  await HintCell.create({ articleId: 10, area: "alpha", publishAt: NOW, slotTime: NOW, status: HintCellStatus.Open });
});
afterAll(disconnectTestDb);

async function runTurn(steps: StreamStep[], options: { web?: boolean; deep?: boolean; conversation?: UIMessage[] } = {}) {
  const chat = mockStreamModel(steps);
  const deep = mockStreamModel(steps);
  const models: IntelChatModels = { chat, deep, tool: mockModel(() => "") };
  let saved: UIMessage[] | null = null;
  const stream = await streamIntelChat({
    models,
    item: (await loadItemView(10))!,
    article: { id: 10, content: CONTENT, contentHash: "h" },
    conversation: options.conversation ?? [question],
    web: options.web ?? false,
    deep: options.deep ?? false,
    now: NOW,
    abortSignal: new AbortController().signal,
    onEnd: (messages) => {
      saved = messages;
    },
    downloadImages: async () => [{ name: "alpha.png", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) }],
  });
  const chunks = await convertReadableStreamToArray(stream);
  return { chunks, saved: saved as UIMessage[] | null, chat, deep };
}

describe("streamIntelChat", () => {
  test("runs a tool, streams the answer and hands every message to onEnd", async () => {
    const { chunks, saved } = await runTurn([{ toolCalls: [{ id: "c1", name: "proposeHintAnswer", input: { area: "alpha", answer: "1884 4407" } }] }, { text: "Alpha staat klaar." }]);
    expect(chunks.find((chunk) => chunk.type === "tool-output-available")).toMatchObject({ toolCallId: "c1", output: { area: "alpha", answer: "1884 4407", kind: "rd" } });
    expect(chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => (chunk as { delta: string }).delta).join("")).toBe("Alpha staat klaar.");
    expect(saved?.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(saved?.[1].parts.map((part) => part.type)).toEqual(["step-start", "tool-proposeHintAnswer", "step-start", "text"]);
  });

  test("system prompt, item images on the first user message, web tools off by default", async () => {
    const { chat } = await runTurn([{ text: "ok" }]);
    const call = chat.doStreamCalls[0];
    expect(call.prompt[0]).toMatchObject({ role: "system" });
    expect(JSON.stringify(call.prompt[0])).toContain("Titel: Hint 10");
    const firstUser = call.prompt.find((message) => message.role === "user")!;
    expect(JSON.stringify(firstUser.content)).toContain("Afbeeldingen van het open item: alpha.png");
    expect((firstUser.content as { type: string }[]).some((part) => part.type === "file")).toBe(true);
    const names = call.tools?.map((tool) => tool.name) ?? [];
    expect(names).toContain("getItem");
    expect(names).toContain("proposeHintAnswer");
    expect(names).not.toContain("webSearch");
    expect(call.providerOptions).toEqual({ google: { thinkingConfig: { includeThoughts: true } } });
  });

  test("streams the model's thought summaries as reasoning chunks and keeps them on the message", async () => {
    const { chunks, saved } = await runTurn([{ reasoning: "Eerst de coördinaten.", signature: "sig-1", text: "Alpha staat klaar." }]);
    const types = chunks.map((chunk) => chunk.type);
    expect(types).toContain("reasoning-start");
    expect(types).toContain("reasoning-end");
    expect(types.indexOf("reasoning-end")).toBeLessThan(types.indexOf("text-start"));
    expect(chunks.filter((chunk) => chunk.type === "reasoning-delta").map((chunk) => (chunk as { delta: string }).delta).join("")).toBe("Eerst de coördinaten.");
    const reasoning = saved?.[1].parts.find((part) => part.type === "reasoning");
    expect(reasoning).toMatchObject({ text: "Eerst de coördinaten.", providerMetadata: { google: { thoughtSignature: "sig-1" } } });
  });

  test("web on offers webSearch; deep uses the deep model with high thinking", async () => {
    const { chat, deep } = await runTurn([{ text: "ok" }], { web: true, deep: true });
    expect(chat.doStreamCalls).toHaveLength(0);
    const call = deep.doStreamCalls[0];
    expect(call.tools?.map((tool) => tool.name)).toContain("webSearch");
    expect(call.providerOptions).toEqual({ google: { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } } });
  });

  test("a follow-up after a tool turn works with the history as stored (undefined optional fields)", async () => {
    const first = await runTurn([{ toolCalls: [{ id: "c1", name: "proposeHintAnswer", input: { area: "alpha", answer: "1884 4407" } }] }, { text: "Alpha staat klaar." }]);
    const userId = new mongoose.Types.ObjectId();
    await saveChat(userId, 10, first.saved!);
    const stored = await loadChat(userId, 10);
    const followUp: UIMessage = { id: "u2", role: "user", parts: [{ type: "text", text: "En nu?" }] };
    const { chunks, chat } = await runTurn([{ text: "Verder." }], { conversation: [...stored, followUp] });
    expect(chunks.find((chunk) => chunk.type === "error")).toBeUndefined();
    expect(chat.doStreamCalls).toHaveLength(1);
    expect(chat.doStreamCalls[0].prompt.some((message) => message.role === "tool")).toBe(true);
    // Stored without undefined → null, provider metadata kept
    const toolPart = stored[1].parts.find((part) => part.type === "tool-proposeHintAnswer") as Record<string, unknown>;
    expect(Object.values(toolPart)).not.toContain(null);
  });

  test("a follow-up on a stored history with reasoning sends it back as a signed thought", async () => {
    const first = await runTurn([{ reasoning: "Eerst de coördinaten.", signature: "sig-1", text: "Alpha staat klaar." }]);
    const userId = new mongoose.Types.ObjectId();
    await saveChat(userId, 10, first.saved!);
    const stored = await loadChat(userId, 10);
    expect(stored[1].parts.some((part) => part.type === "reasoning")).toBe(true);
    const followUp: UIMessage = { id: "u2", role: "user", parts: [{ type: "text", text: "En nu?" }] };
    const { chunks, chat } = await runTurn([{ text: "Verder." }], { conversation: [...stored, followUp] });
    expect(chunks.find((chunk) => chunk.type === "error")).toBeUndefined();
    const assistant = chat.doStreamCalls[0].prompt.find((message) => message.role === "assistant")!;
    expect(assistant.content).toEqual([
      { type: "reasoning", text: "Eerst de coördinaten.", providerOptions: { google: { thoughtSignature: "sig-1" } } },
      { type: "text", text: "Alpha staat klaar." },
    ]);
  });

  test("history stored with nulls in optional part fields (older chats) still works", async () => {
    const first = await runTurn([{ toolCalls: [{ id: "c1", name: "proposeHintAnswer", input: { area: "alpha", answer: "1884 4407" } }] }, { text: "Alpha staat klaar." }]);
    const withNulls = first.saved!.map((message) => ({
      ...message,
      parts: message.parts.map((part) =>
        part.type.startsWith("tool-") ? ({ ...part, title: null, rawInput: null, errorText: null, providerExecuted: null, preliminary: null } as unknown as typeof part) : part,
      ),
    }));
    const followUp: UIMessage = { id: "u2", role: "user", parts: [{ type: "text", text: "En nu?" }] };
    const { chunks, chat } = await runTurn([{ text: "Verder." }], { conversation: [...withNulls, followUp] });
    expect(chunks.find((chunk) => chunk.type === "error")).toBeUndefined();
    expect(chat.doStreamCalls).toHaveLength(1);
    expect(chat.doStreamCalls[0].prompt.some((message) => message.role === "tool")).toBe(true);
  });

  test("a failing model is not dumped to the console (the raw error holds the prompt and images)", async () => {
    const failing = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("raw-boom requestBodyValues secret prompt");
      },
    });
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const stream = await streamIntelChat({
        models: { chat: failing, deep: failing, tool: mockModel(() => "") },
        item: (await loadItemView(10))!,
        article: { id: 10, content: CONTENT, contentHash: "h" },
        conversation: [question],
        web: false,
        deep: false,
        now: NOW,
        abortSignal: new AbortController().signal,
        onEnd: () => {},
        downloadImages: async () => [],
      });
      const chunks = await convertReadableStreamToArray(stream);
      const error = chunks.find((chunk) => chunk.type === "error") as { errorText: string } | undefined;
      expect(error?.errorText).toBeDefined();
      expect(error?.errorText).not.toContain("raw-boom");
      const printed = consoleError.mock.calls.flat().map((arg) => (arg instanceof Error ? `${arg.message}` : String(arg)));
      expect(printed.some((text) => text.includes("raw-boom"))).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });
});
