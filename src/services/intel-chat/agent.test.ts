import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { convertReadableStreamToArray } from "ai/test";
import { Article } from "../../models/article.model";
import { HintCell, HintCellStatus } from "../../models/hint-cell.model";
import { mockModel, mockStreamModel, type StreamStep } from "../../test/ai";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../test/db";
import { streamIntelChat, type IntelChatModels } from "./agent";
import { clearItemImageCache } from "./item-images";
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

async function runTurn(steps: StreamStep[], options: { web?: boolean; deep?: boolean } = {}) {
  const chat = mockStreamModel(steps);
  const deep = mockStreamModel(steps);
  const models: IntelChatModels = { chat, deep, tool: mockModel(() => "") };
  let saved: UIMessage[] | null = null;
  const stream = await streamIntelChat({
    models,
    item: (await loadItemView(10))!,
    article: { id: 10, content: CONTENT, contentHash: "h" },
    conversation: [question],
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
    expect(call.providerOptions?.google).toBeUndefined();
  });

  test("web on offers webSearch; deep uses the deep model with high thinking", async () => {
    const { chat, deep } = await runTurn([{ text: "ok" }], { web: true, deep: true });
    expect(chat.doStreamCalls).toHaveLength(0);
    const call = deep.doStreamCalls[0];
    expect(call.tools?.map((tool) => tool.name)).toContain("webSearch");
    expect(call.providerOptions).toEqual({ google: { thinkingConfig: { thinkingLevel: "high" } } });
  });
});
