import { describe, expect, test } from "bun:test";
import type { ModelMessage, UIMessage } from "ai";
import { clearItemImageCache, loadItemImages } from "./item-images";
import { appendMessage, DROPPED_IMAGE_TEXT, forStorage, MAX_HISTORY_TO_MODEL, modelWindow, parseIncomingMessage, withItemImages, withoutNullPartFields } from "./messages";
import { buildSystemPrompt, dutchDateTime } from "./prompt";
import type { ItemView } from "./tools/app-data";

const png = (bytes: number) => `data:image/png;base64,${Buffer.alloc(bytes, 1).toString("base64")}`;
const user = (id: string, text = "vraag", extra: UIMessage["parts"] = []): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }, ...extra] });
const assistant = (id: string, text = "antwoord"): UIMessage => ({ id, role: "assistant", parts: [{ type: "step-start" }, { type: "text", text, state: "done" }] });

describe("parseIncomingMessage", () => {
  test("a text message, trimmed; with one image", () => {
    expect(parseIncomingMessage({ id: "m1", role: "user", parts: [{ type: "text", text: "  Los Alpha op  " }] })).toEqual(user("m1", "Los Alpha op"));
    const withImage = parseIncomingMessage({ id: "m2", role: "user", parts: [{ type: "text", text: "kijk" }, { type: "file", mediaType: "image/png", url: png(100), filename: "foto.png" }] });
    expect(withImage?.parts[1]).toEqual({ type: "file", mediaType: "image/png", url: png(100), filename: "foto.png" });
  });

  test("refuses everything outside the contract", () => {
    const bad: unknown[] = [
      null,
      "hoi",
      { id: "m", role: "assistant", parts: [{ type: "text", text: "x" }] },
      { id: "", role: "user", parts: [{ type: "text", text: "x" }] },
      { id: "m", role: "user", parts: [] },
      { id: "m", role: "user", parts: [{ type: "text", text: "   " }] },
      { id: "m", role: "user", parts: [{ type: "text", text: "x".repeat(4001) }] },
      { id: "m", role: "user", parts: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
      { id: "m", role: "user", parts: [{ type: "text", text: "a" }, { type: "tool-getItem", toolCallId: "x" }] },
      { id: "m", role: "user", parts: [{ type: "text", text: "a" }, { type: "file", mediaType: "image/gif", url: "data:image/gif;base64,AAAA" }] },
      { id: "m", role: "user", parts: [{ type: "text", text: "a" }, { type: "file", mediaType: "image/png", url: "https://example.org/a.png" }] },
      { id: "m", role: "user", parts: [{ type: "text", text: "a" }, { type: "file", mediaType: "image/png", url: png(2 * 1024 * 1024 + 1) }] },
      { id: "m", role: "user", parts: [{ type: "text", text: "a" }, { type: "file", mediaType: "image/png", url: png(10) }, { type: "file", mediaType: "image/png", url: png(10) }] },
    ];
    for (const value of bad) expect(parseIncomingMessage(value)).toBeNull();
  });

  test("an image of exactly 2 MB is fine", () => {
    expect(parseIncomingMessage({ id: "m", role: "user", parts: [{ type: "text", text: "a" }, { type: "file", mediaType: "image/png", url: png(2 * 1024 * 1024) }] })).not.toBeNull();
  });
});

describe("appendMessage", () => {
  test("appends; a known id replaces it and what came after (retry)", () => {
    const history = [user("u1"), assistant("a1"), user("u2"), assistant("a2")];
    expect(appendMessage(history, user("u3")).map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2", "u3"]);
    expect(appendMessage(history, user("u2", "opnieuw")).map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
  });
});

describe("forStorage", () => {
  test("keeps only the newest 2 user images, finishes streaming text and drops empty assistant messages", () => {
    const image = (n: number) => ({ type: "file" as const, mediaType: "image/png", url: png(n) });
    const messages: UIMessage[] = [
      user("u1", "a", [image(1)]),
      user("u2", "b", [image(2)]),
      user("u3", "c", [image(3)]),
      { id: "a3", role: "assistant", parts: [{ type: "step-start" }] },
      { id: "a4", role: "assistant", parts: [{ type: "step-start" }, { type: "text", text: "half", state: "streaming" }] },
    ];
    const stored = forStorage(messages);
    expect(stored.map((m) => m.id)).toEqual(["u1", "u2", "u3", "a4"]);
    expect(stored[0].parts[1]).toEqual({ type: "text", text: DROPPED_IMAGE_TEXT });
    expect(stored[1].parts[1]).toEqual(image(2));
    expect(stored[2].parts[1]).toEqual(image(3));
    expect(stored[3].parts[1]).toEqual({ type: "text", text: "half", state: "done" });
  });
});

describe("modelWindow", () => {
  test("the newest 40, starting at a user message", () => {
    const messages = Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? user(`u${i}`) : assistant(`a${i}`)));
    const window = modelWindow(messages);
    expect(window.length).toBeLessThanOrEqual(MAX_HISTORY_TO_MODEL);
    expect(window[0].role).toBe("user");
    expect(window.at(-1)?.id).toBe("a49");
  });
});

describe("withItemImages", () => {
  test("puts the item images in front of the first user message", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "eerste" },
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "text", text: "tweede" }] },
    ];
    const result = withItemImages(messages, [{ name: "kaart.png", mediaType: "image/png", data: new Uint8Array([1, 2]) }]);
    expect(result[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Afbeeldingen van het open item: kaart.png" },
        { type: "file", data: new Uint8Array([1, 2]), mediaType: "image/png", filename: "kaart.png" },
        { type: "text", text: "eerste" },
      ],
    });
    expect(result[2]).toBe(messages[2]);
    expect(withItemImages(messages, [])).toBe(messages);
  });
});

describe("loadItemImages", () => {
  const article = { id: 1, contentHash: "h1", content: '<img src="https://cdn.jotihunt.net/a.png" alt="a.png">' };

  test("downloads once per article content within 10 minutes; never throws", async () => {
    clearItemImageCache();
    let calls = 0;
    const download = async () => {
      calls++;
      return [{ name: "a.png", mediaType: "image/png", data: new Uint8Array([1]) }];
    };
    expect(await loadItemImages(article, download, 0)).toHaveLength(1);
    await loadItemImages(article, download, 60_000);
    expect(calls).toBe(1);
    await loadItemImages(article, download, 11 * 60_000);
    expect(calls).toBe(2);
    expect(await loadItemImages({ ...article, contentHash: "h2" }, async () => Promise.reject(new Error("down")), 0)).toEqual([]);
    expect(await loadItemImages({ id: 2, content: "<p>geen plaatjes</p>" }, download, 0)).toEqual([]);
  });
});

describe("buildSystemPrompt", () => {
  const item: ItemView = {
    articleId: 10,
    title: "De Highland Games",
    kind: "hint",
    publishAt: "2026-10-17T12:00:00.000Z",
    endTime: null,
    maxPoints: null,
    summary: "Een hint over spelen",
    text: "Intro\nAlpha: [afbeelding]\nBravo: -",
    images: [
      { name: "alpha.png", url: "https://cdn.jotihunt.net/a.png" },
      { name: "extern.png", url: "https://example.org/x.png" },
    ],
    attachments: ["puzzel.zip"],
    hintCells: [
      { area: "alpha", status: "solved", slotTime: "2026-10-17T12:00:00.000Z", answer: "1884 4407", location: { lat: 51.95, lng: 5.87 }, snippet: "Alpha: plaatje" },
      { area: "bravo", status: "none", slotTime: "2026-10-17T12:00:00.000Z", answer: null, location: null, snippet: null },
    ],
  };
  const now = new Date("2026-10-17T12:05:00Z");

  test("rules, Dutch time, the item with its cells and images", () => {
    const prompt = buildSystemPrompt({ item, now, web: true, attachedImages: ["alpha.png"] });
    expect(dutchDateTime(now)).toBe("zaterdag 17 oktober 14:05");
    expect(prompt).toContain("zaterdag 17 oktober 14:05");
    expect(prompt).toContain("Titel: De Highland Games");
    expect(prompt).toContain('- Alpha: opgelost, antwoord "1884 4407" | deel: Alpha: plaatje');
    expect(prompt).toContain("- Bravo: geen hint");
    expect(prompt).toContain("in deze volgorde bijgevoegd bij het eerste bericht: alpha.png");
    expect(prompt).toContain("Afbeeldingen die je niet kunt zien: extern.png");
    expect(prompt).toContain("Bijlagen (niet leesbaar voor jou): puzzel.zip");
    expect(prompt).toContain("1884 4407");
    expect(prompt).toContain("webSearch");
    expect(prompt).toContain("checkPoint");
  });

  test("web off tells the model to suggest switching Web on", () => {
    const prompt = buildSystemPrompt({ item, now, web: false, attachedImages: [] });
    expect(prompt).toContain('Internet staat uit');
    expect(prompt).not.toContain("gebruik webSearch");
  });
});

describe("withoutNullPartFields", () => {
  test("drops null part fields, keeps nulls inside tool input/output and provider metadata", () => {
    const part = {
      type: "tool-getItem",
      toolCallId: "c1",
      state: "output-available",
      title: null,
      rawInput: null,
      errorText: null,
      providerExecuted: null,
      preliminary: null,
      input: { area: null },
      output: { nearestGroup: null },
      callProviderMetadata: { google: { thoughtSignature: "sig" } },
    };
    const [message] = withoutNullPartFields([{ id: "a1", role: "assistant", parts: [part as unknown as UIMessage["parts"][number]] }]);
    expect(message.parts[0] as unknown).toEqual({
      type: "tool-getItem",
      toolCallId: "c1",
      state: "output-available",
      input: { area: null },
      output: { nearestGroup: null },
      callProviderMetadata: { google: { thoughtSignature: "sig" } },
    });
  });
});
