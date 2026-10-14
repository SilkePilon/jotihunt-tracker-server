import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { APICallError } from "ai";
import { Article } from "../models/article.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { mockModel } from "../test/ai";
import { GeminiError } from "./ai/gemini-error";
import { fetchImages, type ArticleImage, type FetchedImage } from "./article-media";
import {
  buildSummaryPrompt,
  createArticleSummarizer,
  createSummaryJob,
  findPendingSummaries,
  storeSummary,
  summaryKey,
  SUMMARY_MAX_PAUSE_MS,
  SUMMARY_PAUSE_MS,
  SUMMARY_TIMEOUT_MS,
  type ArticleSummary,
} from "./article-summary.service";

const article = (id: number, type: string, extra: Record<string, unknown> = {}) =>
  Article.create({ id, title: `Titel ${id}`, type, publishAt: new Date(`2026-10-17T1${id % 10}:00:00Z`), content: `<div>Tekst ${id}</div>`, contentHash: `hash-${id}`, ...extra });

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("createArticleSummarizer", () => {
  const input = { title: "Vossen wisselen", type: "news", content: "<div>Om <strong>23:00</strong> wisselen de vossen.</div>" };

  test("the default deadline is 30 seconds", () => {
    expect(SUMMARY_TIMEOUT_MS).toBe(30_000);
  });

  test("sends title and plain text, asks for JSON with the schema, returns the cleaned summary", async () => {
    const model = mockModel(() => JSON.stringify({ summary: "  Om 23:00 wisselen de vossen.  " }));
    const result = await createArticleSummarizer({ model }).summarize(input);
    expect(result).toEqual({ summary: "Om 23:00 wisselen de vossen." });
    const [call] = model.doGenerateCalls;
    const text = (call.prompt[0].content as { type: string; text: string }[])[0].text;
    expect(text).toContain("Title: Vossen wisselen");
    expect(text).toContain("Om 23:00 wisselen de vossen.");
    expect(text).not.toContain("<strong>");
    expect(call.responseFormat).toMatchObject({ type: "json" });
    expect((call.responseFormat as { schema?: unknown }).schema).toBeDefined();
    expect(call.temperature).toBe(0.2);
  });

  test("an assignment prompt carries deadline and publication time (Dutch weekday and time) and points", async () => {
    const model = mockModel(() => JSON.stringify({ summary: "s" }));
    await createArticleSummarizer({ model }).summarize({
      title: "Doedelzak",
      type: "assignment",
      content: "<div>bouw</div>",
      publishAt: new Date("2026-10-16T22:05:00Z"),
      endTime: new Date("2026-10-17T13:30:00Z"),
      maxPoints: 30,
    });
    const text = (model.doGenerateCalls[0].prompt[0].content as { text: string }[])[0].text;
    expect(text).toContain("assignment");
    expect(text).toContain("Published: zaterdag 00:05\n");
    expect(text).toContain("Deadline: zaterdag 15:30\n");
    expect(text).toContain("Max points: 30");
  });

  test("a prompt without publication time or deadline has neither line", async () => {
    const model = mockModel(() => JSON.stringify({ summary: "s" }));
    await createArticleSummarizer({ model }).summarize(input);
    const text = (model.doGenerateCalls[0].prompt[0].content as { text: string }[])[0].text;
    expect(text).not.toContain("Published:");
    expect(text).not.toContain("Deadline:");
  });

  test("cuts a long summary", async () => {
    const model = mockModel(() => JSON.stringify({ summary: "y".repeat(900) }));
    const result = await createArticleSummarizer({ model }).summarize(input);
    expect(result.summary).toHaveLength(600);
  });

  test("the prompt asks for a summary only", () => {
    const prompt = buildSummaryPrompt({ title: "t", type: "news", content: "c" });
    expect(prompt).toContain('"summary"');
    expect(prompt).not.toContain('"points"');
  });

  test("an empty summary or a wrong shape is a non-retryable GeminiError", async () => {
    for (const answer of ['{"summary":""}', '{}', "not json"]) {
      const error = (await createArticleSummarizer({ model: mockModel(() => answer) })
        .summarize(input)
        .catch((caught: unknown) => caught)) as GeminiError;
      expect(error).toBeInstanceOf(GeminiError);
      expect(error.retryable).toBe(false);
    }
  });

  test("an API error becomes a GeminiError and the model is called once", async () => {
    const model = mockModel(() => {
      throw new APICallError({ message: "x", url: "u", requestBodyValues: {}, statusCode: 503, isRetryable: true });
    });
    const error = (await createArticleSummarizer({ model })
      .summarize(input)
      .catch((caught: unknown) => caught)) as GeminiError;
    expect(error.status).toBe(503);
    expect(model.doGenerateCalls).toHaveLength(1);
  });
});

describe("createArticleSummarizer with images", () => {
  const html =
    `<div>Zie de afbeeldingen.<img src="https://cdn.jotihunt.net/a.png" alt="Kaart"></div>` +
    `<figure data-trix-attachment="{&quot;contentType&quot;:&quot;image/png&quot;,&quot;filename&quot;:&quot;Route.png&quot;,&quot;url&quot;:&quot;https://cdn.jotihunt.net/b.png&quot;}"><img src="https://cdn.jotihunt.net/b.png"></figure>` +
    `<figure data-trix-attachment="{&quot;contentType&quot;:&quot;application/zip&quot;,&quot;filename&quot;:&quot;alpha.zip&quot;}"><a href="https://cdn.jotihunt.net/alpha.zip"></a></figure>`;
  const input = { title: "Plaatjes", type: "news", content: html };
  const textOf = (call: { prompt: { content: unknown }[] }) => (call.prompt[0].content as { type: string; text: string }[])[0].text;

  test("sends the images as file parts in order, with a names line; other files only by name", async () => {
    const model = mockModel(() => JSON.stringify({ summary: "s" }));
    let asked: unknown;
    const fetchImages = async (images: ArticleImage[]): Promise<FetchedImage[]> => {
      asked = images;
      return [
        { data: new Uint8Array([1]), mediaType: "image/png", name: "Kaart" },
        { data: new Uint8Array([2, 2]), mediaType: "image/jpeg", name: "Route.png" },
      ];
    };
    await createArticleSummarizer({ model, fetchImages }).summarize(input);
    expect(asked).toEqual([
      { url: "https://cdn.jotihunt.net/a.png", name: "Kaart" },
      { url: "https://cdn.jotihunt.net/b.png", name: "Route.png" },
    ]);
    const [call] = model.doGenerateCalls;
    expect(call.prompt).toHaveLength(1);
    expect(call.prompt[0].role).toBe("user");
    const parts = call.prompt[0].content as { type: string; mediaType?: string; data?: unknown }[];
    expect(parts.map((part) => part.type)).toEqual(["text", "file", "file"]);
    expect(parts.slice(1).map((part) => part.mediaType)).toEqual(["image/png", "image/jpeg"]);
    expect(parts[1].data).toEqual({ type: "data", data: new Uint8Array([1]) });
    expect(parts[2].data).toEqual({ type: "data", data: new Uint8Array([2, 2]) });
    const text = textOf(call);
    expect(text).toContain("Bijgevoegde afbeeldingen: Kaart, Route.png");
    expect(text).not.toContain("Niet bijgevoegde");
    expect(text).toContain("Bijlagen: alpha.zip");
    expect(text).toContain("images");
  });

  test("without images: no file parts and no names line", async () => {
    const model = mockModel(() => JSON.stringify({ summary: "s" }));
    let called = false;
    await createArticleSummarizer({
      model,
      fetchImages: async () => {
        called = true;
        return [];
      },
    }).summarize({ title: "t", type: "news", content: "<div>alleen tekst</div>" });
    const [call] = model.doGenerateCalls;
    expect((call.prompt[0].content as { type: string }[]).map((part) => part.type)).toEqual(["text"]);
    expect(textOf(call)).not.toContain("Bijgevoegde afbeeldingen");
    expect(textOf(call)).not.toContain("Bijlagen");
    expect(called).toBe(false);
  });

  test("images that could not be downloaded are left out; a throwing download never fails the summary", async () => {
    const model = mockModel(() => JSON.stringify({ summary: "s" }));
    const result = await createArticleSummarizer({
      model,
      fetchImages: async () => {
        throw new Error("kapot");
      },
    }).summarize(input);
    expect(result).toEqual({ summary: "s" });
    const [call] = model.doGenerateCalls;
    expect((call.prompt[0].content as { type: string }[]).map((part) => part.type)).toEqual(["text"]);
    expect(textOf(call)).not.toContain("Bijgevoegde afbeeldingen");
    expect(textOf(call)).toContain("Bijlagen: alpha.zip");
    expect(textOf(call)).toContain("Niet bijgevoegde afbeeldingen: Kaart, Route.png");
  });

  test("images that are not attached (e.g. not on a Jotihunt host) are only named", async () => {
    const model = mockModel(() => JSON.stringify({ summary: "s" }));
    const content = `<img src="https://imgur.com/x.png" alt="Elders"><img src="https://cdn.jotihunt.net/a.png" alt="Kaart">`;
    await createArticleSummarizer({
      model,
      // The real download: the imgur image is never requested
      fetchImages: (images) => fetchImages(images, { fetch: async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }) }),
    }).summarize({ title: "t", type: "news", content });
    const [call] = model.doGenerateCalls;
    expect((call.prompt[0].content as { type: string }[]).map((part) => part.type)).toEqual(["text", "file"]);
    expect(textOf(call)).toContain("Bijgevoegde afbeeldingen: Kaart");
    expect(textOf(call)).toContain("Niet bijgevoegde afbeeldingen: Elders");
  });
});

describe("findPendingSummaries and storeSummary", () => {
  test("pending: news and assignments without a summary of their current content, newest first, never hints or seeded test articles", async () => {
    await article(1, "news");
    await article(2, "assignment");
    await article(3, "hint");
    await article(4, "news", { summary: "klaar", summaryHash: "hash-4:v2" });
    await article(5, "news", { summary: "oud", summaryHash: "eerdere-hash:v2" });
    // Made before images were sent (no version): summarised once more
    await article(7, "news", { summary: "zonder plaatjes", summaryHash: "hash-7" });
    await article(900001, "news");
    await article(6, "news", { contentHash: undefined });
    expect((await findPendingSummaries(10)).map((pending) => pending.id)).toEqual([7, 5, 2, 1]);
    expect((await findPendingSummaries(2)).map((pending) => pending.id)).toEqual([7, 5]);
    expect((await findPendingSummaries(1))[0].publishAt).toEqual(new Date("2026-10-17T17:00:00Z"));
  });

  test("storeSummary stores for the content it was made from, and not for content that changed meanwhile", async () => {
    await article(1, "news");
    await Article.collection.updateOne({ id: 1 }, { $set: { summaryPoints: ["oud"] } });
    await storeSummary({ id: 1, contentHash: "hash-1" }, { summary: "kort" });
    expect(await Article.findOne({ id: 1 }).lean()).toMatchObject({ summary: "kort", summaryHash: "hash-1:v2" });
    expect(summaryKey("hash-1")).toBe("hash-1:v2");
    expect(await findPendingSummaries(10)).toEqual([]);
    expect(await Article.findOne({ id: 1 }).lean()).not.toHaveProperty("summaryPoints");
    await storeSummary({ id: 1, contentHash: "andere-hash" }, { summary: "fout" });
    expect((await Article.findOne({ id: 1 }).lean())?.summary).toBe("kort");
  });
});

describe("createSummaryJob", () => {
  const ok: ArticleSummary = { summary: "kort" };
  const unreachable = () => new GeminiError("Gemini niet bereikbaar", true);

  test("the pause after an outage is 2 minutes, at most 15", () => {
    expect(SUMMARY_PAUSE_MS).toBe(120_000);
    expect(SUMMARY_MAX_PAUSE_MS).toBe(900_000);
  });

  test("summarises pending articles and stores them", async () => {
    await article(1, "news");
    await article(2, "assignment");
    const seen: string[] = [];
    const job = createSummaryJob({
      summarizer: {
        summarize: async (input) => {
          seen.push(input.title);
          return ok;
        },
      },
      batch: 2,
    });
    const result = await job.run();
    expect(result.done.sort()).toEqual([1, 2]);
    expect(seen.sort()).toEqual(["Titel 1", "Titel 2"]);
    expect(await Article.countDocuments({ summary: "kort" })).toBe(2);
    expect((await job.run()).done).toEqual([]);
  });

  test("a failing article is tried twice for the same content, then left alone; other articles go on", async () => {
    await article(1, "news");
    await article(2, "news");
    let calls = 0;
    const job = createSummaryJob({
      summarizer: {
        summarize: async (input) => {
          if (input.title === "Titel 1") {
            calls++;
            throw new GeminiError("Gemini gaf geen geldig antwoord", false);
          }
          return ok;
        },
      },
      batch: 2,
    });
    const first = await job.run();
    expect(first.done).toEqual([2]);
    expect(first.failed.map((failure) => failure.id)).toEqual([1]);
    await job.run();
    await job.run();
    expect(calls).toBe(2);
    // New content: tried again
    await Article.updateOne({ id: 1 }, { $set: { contentHash: "nieuw" } });
    await job.run();
    expect(calls).toBe(3);
  });

  test("an error that is not a GeminiError counts toward giving up too", async () => {
    await article(1, "news");
    let calls = 0;
    const job = createSummaryJob({
      summarizer: {
        summarize: async () => {
          calls++;
          throw new Error("bug");
        },
      },
    });
    for (let run = 0; run < 4; run++) await job.run();
    expect(calls).toBe(2);
  });

  test("one article per run by default, at most `batch` when given", async () => {
    for (const id of [1, 2, 3, 4, 5]) await article(id, "news");
    expect((await createSummaryJob({ summarizer: { summarize: async () => ok } }).run()).done).toHaveLength(1);
    expect((await createSummaryJob({ summarizer: { summarize: async () => ok }, batch: 3 }).run()).done).toHaveLength(3);
  });

  test("a retryable failure stops the run and pauses the job", async () => {
    await article(1, "news");
    await article(2, "news");
    let time = 1_000_000;
    let calls = 0;
    let runs = 0;
    let failing = true;
    const job = createSummaryJob({
      summarizer: {
        summarize: async () => {
          calls++;
          if (failing) throw unreachable();
          return ok;
        },
      },
      batch: 2,
      now: () => time,
      beginRun: () => {
        runs++;
        return (fn) => fn();
      },
    });

    const first = await job.run();
    expect(calls).toBe(1);
    expect(first.done).toEqual([]);
    expect(first.failed).toHaveLength(1);
    expect(first.failed[0].error).toBeInstanceOf(GeminiError);

    // Paused: no Gemini call and no database read
    expect(await job.run()).toEqual({ done: [], failed: [] });
    time += SUMMARY_PAUSE_MS - 1;
    expect(await job.run()).toEqual({ done: [], failed: [] });
    expect(calls).toBe(1);
    expect(runs).toBe(1);

    // After 2 minutes it tries again; a second failure in a row pauses 4 minutes
    time += 1;
    expect((await job.run()).failed).toHaveLength(1);
    expect(calls).toBe(2);
    time += 2 * SUMMARY_PAUSE_MS - 1;
    await job.run();
    expect(calls).toBe(2);
    time += 1;

    // A success resets the pause to 2 minutes
    failing = false;
    expect((await job.run()).done.sort()).toEqual([1, 2]);
    expect(calls).toBe(4);
    await article(3, "news");
    failing = true;
    expect((await job.run()).failed).toHaveLength(1);
    expect(calls).toBe(5);
    time += SUMMARY_PAUSE_MS - 1;
    await job.run();
    expect(calls).toBe(5);
    time += 1;
    await job.run();
    expect(calls).toBe(6);
  });

  test("the pause doubles up to 15 minutes", async () => {
    await article(1, "news");
    let time = 0;
    let calls = 0;
    const job = createSummaryJob({
      summarizer: {
        summarize: async () => {
          calls++;
          throw unreachable();
        },
      },
      now: () => time,
    });
    // 2, 4, 8, 15, 15 minutes
    for (const pause of [120_000, 240_000, 480_000, SUMMARY_MAX_PAUSE_MS, SUMMARY_MAX_PAUSE_MS]) {
      const before = calls;
      await job.run();
      expect(calls).toBe(before + 1);
      time += pause - 1;
      await job.run();
      expect(calls).toBe(before + 1);
      time += 1;
    }
  });

  test("a retryable failure does not count toward giving up", async () => {
    await article(1, "news");
    let time = 0;
    let calls = 0;
    const job = createSummaryJob({
      summarizer: {
        summarize: async () => {
          if (++calls <= 5) throw unreachable();
          return ok;
        },
      },
      maxAttempts: 2,
      now: () => time,
    });
    for (let outage = 0; outage < 5; outage++) {
      expect((await job.run()).failed.map((failure) => failure.id)).toEqual([1]);
      time += SUMMARY_MAX_PAUSE_MS;
    }
    expect((await job.run()).done).toEqual([1]);
    expect(calls).toBe(6);
    expect((await Article.findOne({ id: 1 }).lean())?.summary).toBe("kort");
  });

  test("a stored summary clears the article's failed attempts", async () => {
    await article(1, "news");
    let fail = true;
    let calls = 0;
    const job = createSummaryJob({
      summarizer: {
        summarize: async () => {
          calls++;
          if (fail) throw new GeminiError("Gemini gaf geen geldig antwoord", false);
          return ok;
        },
      },
    });
    await job.run(); // attempt 1 fails
    fail = false;
    expect((await job.run()).done).toEqual([1]);
    // Same content hash pending again (summary removed): the earlier failure no longer counts
    await Article.updateOne({ id: 1 }, { $unset: { summaryHash: 1 } });
    fail = true;
    await job.run();
    await job.run();
    await job.run();
    expect(calls).toBe(4);
  });

  test("a result is dropped when the tracked store is skipped (demo switch)", async () => {
    await article(1, "news");
    const job = createSummaryJob({ summarizer: { summarize: async () => ok }, beginRun: () => async () => undefined });
    expect((await job.run()).done).toEqual([]);
    expect((await Article.findOne({ id: 1 }).lean())?.summary).toBeUndefined();
  });

  test("every run takes its own tracked wrapper; a skipped store stops the run", async () => {
    await article(1, "news");
    await article(2, "news");
    let begun = 0;
    let calls = 0;
    const job = createSummaryJob({
      summarizer: {
        summarize: async () => {
          calls++;
          return ok;
        },
      },
      batch: 2,
      // The read passes, the store is skipped: a demo switch happened during the Gemini call
      beginRun: () => {
        begun++;
        let reads = 0;
        return async (fn) => (reads++ === 0 ? fn() : undefined);
      },
    });
    expect(await job.run()).toEqual({ done: [], failed: [] });
    expect(calls).toBe(1);
    await job.run();
    expect(begun).toBe(2);
    expect(await Article.countDocuments({ summary: "kort" })).toBe(0);
  });
});
