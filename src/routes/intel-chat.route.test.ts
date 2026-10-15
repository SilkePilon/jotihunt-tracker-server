import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { UIMessage } from "ai";
import type mongoose from "mongoose";
import { Article } from "../models/article.model";
import { HintCell, HintCellStatus } from "../models/hint-cell.model";
import { IntelChat } from "../models/intel-chat.model";
import { User } from "../models/user.model";
import { setIntelChatModels } from "../services/intel-chat/instance";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { mockModel, mockStreamModel, type StreamStep } from "../test/ai";
import { tokenFor, withSession } from "../test/auth";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";
const { app } = await import("../app");

let server: Server;
let base: string;
let chat: ReturnType<typeof mockStreamModel>;

beforeAll(async () => {
  await connectTestDb();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  await clearTestDb();
  await Article.create([
    { id: 10, title: "Hint 10", type: "hint", publishAt: new Date("2026-10-17T12:00:00Z"), content: "<div>Alpha: 1884 4407 in Caesar</div>" },
    { id: 900001, title: "Testhint", type: "hint", publishAt: new Date("2026-10-17T12:00:00Z"), content: "x" },
  ]);
  await HintCell.create({ articleId: 10, area: "alpha", publishAt: new Date("2026-10-17T12:00:00Z"), slotTime: new Date("2026-10-17T12:00:00Z"), status: HintCellStatus.Open });
  useSteps([{ text: "Hallo!" }]);
});
afterEach(() => setIntelChatModels(undefined));
afterAll(async () => {
  server.close();
  await disconnectTestDb();
});

function useSteps(steps: StreamStep[]) {
  chat = mockStreamModel(steps);
  setIntelChatModels({ chat, deep: chat, tool: mockModel(() => "") });
}

let userCount = 0;
const createUser = async () => withSession(await User.create({ name: `Hunter ${++userCount}` }));

function request(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (init.json !== undefined) headers.set("Content-Type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

const question = (id: string, text = "Los Alpha op"): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });
const ask = (token: string, message: unknown, extra: Record<string, unknown> = {}) => request("/intel-chat/10", { method: "POST", token, json: { message, web: false, deep: false, ...extra } });

/** Wait until the stream's onEnd saved the chat */
async function savedMessages(userId: mongoose.Types.ObjectId, count: number): Promise<UIMessage[]> {
  for (let i = 0; i < 50; i++) {
    const chat = await IntelChat.findOne({ userId, articleId: 10 }).lean();
    if ((chat?.messages.length ?? 0) >= count) return chat!.messages as UIMessage[];
    await Bun.sleep(20);
  }
  throw new Error("chat was not saved");
}

describe("/intel-chat", () => {
  test("needs a login", async () => {
    expect((await request("/intel-chat/10")).status).toBe(401);
    expect((await request("/intel-chat/10", { method: "POST", json: {} })).status).toBe(401);
    expect((await request("/intel-chat/10", { method: "DELETE" })).status).toBe(401);
  });

  test("404 for a missing or hidden test article", async () => {
    const token = tokenFor(await createUser());
    for (const id of [5, 900001]) {
      expect(await (await request(`/intel-chat/${id}`, { token })).json()).toEqual({ error: "not_found" });
      expect((await request(`/intel-chat/${id}`, { method: "POST", token, json: { message: question("m1") } })).status).toBe(404);
      expect((await request(`/intel-chat/${id}`, { method: "DELETE", token })).status).toBe(404);
    }
  });

  test("503 ai_unavailable without Gemini", async () => {
    setIntelChatModels(null);
    const token = tokenFor(await createUser());
    const res = await ask(token, question("m1"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "ai_unavailable" });
    expect((await request("/intel-chat/10", { token })).status).toBe(503);
  });

  test("400 invalid_message", async () => {
    const token = tokenFor(await createUser());
    for (const message of [undefined, { id: "x", role: "assistant", parts: [{ type: "text", text: "hoi" }] }, { id: "x", role: "user", parts: [] }]) {
      const res = await ask(token, message);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_message" });
    }
  });

  test("POST streams the answer and saves the conversation; GET returns it; DELETE clears it", async () => {
    const user = await createUser();
    const token = tokenFor(user);
    expect(await (await request("/intel-chat/10", { token })).json()).toEqual({ messages: [] });

    const res = await ask(token, question("m1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    expect(res.headers.get("content-encoding")).toBeNull();
    const body = await res.text();
    expect(body).toContain('"type":"text-delta"');
    expect(body).toContain("Hallo!");

    const saved = await savedMessages(user._id, 2);
    expect(saved[0]).toEqual(question("m1"));
    expect(saved[1]).toMatchObject({ role: "assistant", parts: [{ type: "step-start" }, { type: "text", text: "Hallo!" }] });
    expect((await (await request("/intel-chat/10", { token })).json()).messages).toEqual(saved);

    // Another user sees nothing
    expect(await (await request("/intel-chat/10", { token: tokenFor(await createUser()) })).json()).toEqual({ messages: [] });

    expect((await request("/intel-chat/10", { method: "DELETE", token })).status).toBe(204);
    expect(await (await request("/intel-chat/10", { token })).json()).toEqual({ messages: [] });
  });

  test("the next question goes to the model with the history; web off hides the web tools", async () => {
    const user = await createUser();
    const token = tokenFor(user);
    await (await ask(token, question("m1", "eerste vraag"))).text();
    await savedMessages(user._id, 2);
    await (await ask(token, question("m2", "tweede vraag"))).text();
    await savedMessages(user._id, 4);
    const prompt = JSON.stringify(chat.doStreamCalls[1].prompt);
    expect(prompt).toContain("eerste vraag");
    expect(prompt).toContain("Hallo!");
    expect(prompt).toContain("tweede vraag");
    expect(chat.doStreamCalls[1].tools?.map((tool) => tool.name)).not.toContain("webSearch");
    await (await ask(token, question("m3"), { web: true })).text();
    expect(chat.doStreamCalls[2].tools?.map((tool) => tool.name)).toContain("webSearch");
  });

  test("posting a known message id again (Opnieuw) replaces it and what followed, never duplicates", async () => {
    const user = await createUser();
    const token = tokenFor(user);
    await (await ask(token, question("m1", "eerste vraag"))).text();
    await savedMessages(user._id, 2);
    await (await ask(token, question("m2", "tweede vraag"))).text();
    await savedMessages(user._id, 4);
    useSteps([{ text: "Nieuw antwoord" }]);
    await (await ask(token, question("m2", "tweede vraag"))).text();
    let saved: UIMessage[] = [];
    for (let i = 0; i < 50; i++) {
      saved = (await IntelChat.findOne({ userId: user._id, articleId: 10 }).lean())!.messages as UIMessage[];
      if (JSON.stringify(saved).includes("Nieuw antwoord")) break;
      await Bun.sleep(20);
    }
    expect(saved.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(saved.filter((message) => message.id === "m2")).toHaveLength(1);
    expect(saved[3].parts.find((part) => part.type === "text")).toMatchObject({ text: "Nieuw antwoord" });
    const prompt = JSON.stringify(chat.doStreamCalls[0].prompt);
    expect(prompt.match(/tweede vraag/g)).toHaveLength(1);
  });

  test("a tool call is streamed and stored as a tool part", async () => {
    useSteps([{ toolCalls: [{ id: "c1", name: "showPoint", input: { point: "1884 4407", label: "HQ" } }] }, { text: "Daar." }]);
    const user = await createUser();
    const token = tokenFor(user);
    const body = await (await ask(token, question("m1"))).text();
    expect(body).toContain('"type":"tool-output-available"');
    const saved = await savedMessages(user._id, 2);
    expect(saved[1].parts.find((part) => part.type === "tool-showPoint")).toMatchObject({ state: "output-available", output: { label: "HQ", rdText: "1884 4407" } });
  });

  test("an image up to 2 MB fits through the body parser", async () => {
    const user = await createUser();
    const token = tokenFor(user);
    const url = `data:image/png;base64,${Buffer.alloc(2 * 1024 * 1024, 7).toString("base64")}`;
    const res = await ask(token, { ...question("m1"), parts: [{ type: "text", text: "kijk" }, { type: "file", mediaType: "image/png", url }] });
    expect(res.status).toBe(200);
    await res.text();
    const saved = await savedMessages(user._id, 2);
    expect(saved[0].parts[1]).toMatchObject({ type: "file", mediaType: "image/png" });
  });

  test("a question the client walks away from is saved with what was produced", async () => {
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
    const slow = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunkDelayInMs: 50,
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            ...Array.from({ length: 40 }, (_, i) => ({ type: "text-delta" as const, id: "t", delta: `w${i} ` })),
            { type: "text-end", id: "t" },
            { type: "finish", usage, finishReason: { unified: "stop", raw: undefined } },
          ],
        }),
      }),
    });
    setIntelChatModels({ chat: slow, deep: slow, tool: mockModel(() => "") });
    const user = await createUser();
    const abort = new AbortController();
    const res = await request("/intel-chat/10", { method: "POST", token: tokenFor(user), json: { message: question("m1"), web: false, deep: false }, signal: abort.signal });
    const reader = res.body!.getReader();
    await reader.read();
    await Bun.sleep(300);
    abort.abort();
    const saved = await savedMessages(user._id, 2);
    const text = saved[1].parts.find((part) => part.type === "text") as { text: string; state: string };
    expect(text.text).toStartWith("w0 ");
    expect(text.text.length).toBeLessThan(40 * 4);
    expect(text.state).toBe("done");
  });

  test("429 rate_limited after 30 questions in 10 minutes", async () => {
    const token = tokenFor(await createUser());
    for (let i = 0; i < 30; i++) expect((await ask(token, undefined)).status).toBe(400);
    const res = await ask(token, question("m1"));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });
});
