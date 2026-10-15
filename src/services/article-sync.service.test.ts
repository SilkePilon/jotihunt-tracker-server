import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Article, hintSplitKey, legacySummaryKey, summaryKey, TEXT_DEBOUNCE_MS } from "../models/article.model";
import { Area } from "../models/area.model";
import { HintCell, HintCellStatus } from "../models/hint-cell.model";
import { ApiArticle } from "../types/api";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { floorToHour, syncArticles } from "./article-sync.service";
import { SUMMARY_DEBOUNCE_MS } from "./article-summary.service";
import { articleTextHash } from "./article-text-hash";
import { findPendingHintSplits } from "./hint-split.service";

function apiArticle(id: number, type: string, content: string, publishAt = "2026-10-17T12:05:00.000000Z"): ApiArticle {
  return { id, title: `Article ${id}`, type, publish_at: publishAt, message: { content } } as ApiArticle;
}

const hintHtml = "<div>Alpha: <img src='a.png'><br>Bravo: -<br>Charlie: tekst</div>";

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("floorToHour", () => {
  test("drops minutes, seconds and milliseconds", () => {
    expect(floorToHour(new Date("2026-10-17T12:59:59.999Z")).toISOString()).toBe("2026-10-17T12:00:00.000Z");
  });
});

describe("syncArticles", () => {
  test("creates one cell per default area for a new hint", async () => {
    const result = await syncArticles([apiArticle(1, "hint", hintHtml)]);
    expect(result.cellsCreated).toBe(9);
    const cells = await HintCell.find({ articleId: 1 }).lean();
    expect(cells).toHaveLength(9);
    const bravo = cells.find((cell) => cell.area === "bravo")!;
    expect(bravo.status).toBe(HintCellStatus.None);
    const alpha = cells.find((cell) => cell.area === "alpha")!;
    expect(alpha.status).toBe(HintCellStatus.Open);
    expect(alpha.snippet).toContain("a.png");
    expect(alpha.slotTime.toISOString()).toBe("2026-10-17T12:00:00.000Z");
  });

  test("uses area names from the Area collection when present", async () => {
    await Area.create([
      { name: "Alpha", status: "red", updatedAt: new Date() },
      { name: "Bravo", status: "red", updatedAt: new Date() },
    ]);
    await syncArticles([apiArticle(2, "hint", hintHtml)]);
    const areas = (await HintCell.find({ articleId: 2 }).lean()).map((cell) => cell.area).sort();
    expect(areas).toEqual(["alpha", "bravo"]);
  });

  test("does not create cells for news", async () => {
    await syncArticles([apiArticle(3, "news", "<div>Nieuws</div>")]);
    expect(await HintCell.countDocuments()).toBe(0);
    expect(await Article.countDocuments()).toBe(1);
  });

  test("is idempotent", async () => {
    await syncArticles([apiArticle(4, "hint", hintHtml)]);
    const second = await syncArticles([apiArticle(4, "hint", hintHtml)]);
    expect(second.cellsCreated).toBe(0);
    expect(second.changedHints).toEqual([]);
    expect(await Article.countDocuments()).toBe(1);
    expect(await HintCell.countDocuments()).toBe(9);
  });

  test("keeps articles that are no longer returned by the API", async () => {
    await syncArticles([apiArticle(5, "hint", hintHtml)]);
    await syncArticles([apiArticle(6, "news", "<div>x</div>")]);
    expect(await Article.exists({ id: 5 })).toBeTruthy();
  });

  test("backfills missing areas without duplicating existing cells", async () => {
    await HintCell.create({
      articleId: 8,
      area: "alpha",
      publishAt: new Date("2026-10-17T12:05:00.000Z"),
      slotTime: new Date("2026-10-17T12:00:00.000Z"),
      status: HintCellStatus.Open,
    });

    const result = await syncArticles([apiArticle(8, "hint", hintHtml)]);

    expect(result.cellsCreated).toBe(8);
    const cells = await HintCell.find({ articleId: 8 }).lean();
    expect(cells).toHaveLength(9);
    const alphaCells = cells.filter((cell) => cell.area === "alpha");
    expect(alphaCells).toHaveLength(1);
  });

  test("ignores Area collection names outside DEFAULT_AREAS", async () => {
    await Area.create([{ name: "Zulu", status: "red", updatedAt: new Date() }]);
    const result = await syncArticles([apiArticle(9, "hint", hintHtml)]);
    expect(result.cellsCreated).toBe(9);
    const areas = (await HintCell.find({ articleId: 9 }).lean()).map((cell) => cell.area);
    expect(areas).not.toContain("zulu");
    expect(areas.sort()).toEqual(
      ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "oscar"].sort(),
    );
  });

  test("one article with an invalid publish_at fails without aborting the rest", async () => {
    const bad = apiArticle(10, "hint", hintHtml, "not-a-date");
    const good = apiArticle(11, "hint", hintHtml);
    const result = await syncArticles([bad, good]);
    expect(result.failed).toEqual([10]);
    expect(result.upserted).toBe(1);
    expect(await Article.exists({ id: 10 })).toBeNull();
    expect(await Article.exists({ id: 11 })).toBeTruthy();
    expect(await HintCell.countDocuments({ articleId: 11 })).toBe(9);
  });

  test("flags cells when a hint article changes after publication", async () => {
    await syncArticles([apiArticle(7, "hint", hintHtml)]);
    await HintCell.updateOne({ articleId: 7, area: "alpha" }, { $set: { answer: "1234 5678" } });
    const result = await syncArticles([apiArticle(7, "hint", hintHtml + "<p>correctie</p>")]);
    expect(result.changedHints).toEqual([7]);
    const cells = await HintCell.find({ articleId: 7 }).lean();
    expect(cells.every((cell) => cell.articleChanged)).toBe(true);
    expect(cells.find((cell) => cell.area === "alpha")!.answer).toBe("1234 5678");
  });

  const NOW = new Date("2026-10-17T12:00:00Z");
  const LATER = new Date("2026-10-17T12:05:00Z");
  const stored = async (id: number) => (await Article.findOne({ id }).lean())!;

  test("stores the text hash and when the text changed (now, for a new article)", async () => {
    await syncArticles([apiArticle(30, "news", "<div>Wissel om 23:00</div>")], { now: () => NOW });
    const article = await stored(30);
    expect(article.textHash).toBe(articleTextHash("<div>Wissel om 23:00</div>"));
    expect(article.textChangedAt).toEqual(NOW);
  });

  test("a formatting-only change keeps the text hash, textChangedAt and the summary (the hint flags still follow the raw content)", async () => {
    await syncArticles([apiArticle(31, "news", "<div>Wissel om 23:00</div>")], { now: () => NOW });
    const { textHash, contentHash } = await stored(31);
    await Article.updateOne({ id: 31 }, { $set: { summary: "Wissel om 23:00.", summaryHash: summaryKey(textHash!) } });

    await syncArticles([apiArticle(31, "news", "<div class='trix'><strong>Wissel</strong>  om 23:00</div>")], { now: () => LATER });

    const article = await stored(31);
    expect(article.contentHash).not.toBe(contentHash);
    expect(article).toMatchObject({ textHash, textChangedAt: NOW, summary: "Wissel om 23:00.", summaryHash: summaryKey(textHash!) });
  });

  test("a formatting-only re-save of a hint flags nothing and keeps its split current (no new Gemini split)", async () => {
    const signed = hintHtml.replace("a.png", "https://cdn.example/a/a.png?sig=1");
    await syncArticles([apiArticle(32, "hint", signed)], { now: () => NOW });
    const { textHash } = await stored(32);
    await Article.updateOne({ id: 32 }, { $set: { hintSplitHash: hintSplitKey(textHash!) } });

    // Re-saved in the editor: other markup, a rotated signed image URL
    const resaved = signed.replace("<div>", "<div class='x'>").replace("https://cdn.example/a/a.png?sig=1", "https://cdn2.example/b/a.png?sig=2");
    const result = await syncArticles([apiArticle(32, "hint", resaved)], { now: () => LATER });

    expect(result.changedHints).toEqual([]);
    expect(await HintCell.countDocuments({ articleId: 32, articleChanged: true })).toBe(0);
    expect(await stored(32)).toMatchObject({ textHash, textChangedAt: NOW, hintSplitHash: hintSplitKey(textHash!) });
    expect(await findPendingHintSplits(10, new Date(LATER.getTime() + TEXT_DEBOUNCE_MS + 1))).toEqual([]);
  });

  test("a text change of a hint flags its cells and is split again only after the debounce", async () => {
    await syncArticles([apiArticle(33, "hint", hintHtml)], { now: () => NOW });
    const { textHash } = await stored(33);
    await Article.updateOne({ id: 33 }, { $set: { hintSplitHash: hintSplitKey(textHash!) } });

    const result = await syncArticles([apiArticle(33, "hint", hintHtml.replace("tekst", "andere tekst"))], { now: () => LATER });

    expect(result.changedHints).toEqual([33]);
    expect(await HintCell.countDocuments({ articleId: 33, articleChanged: true })).toBe(9);
    expect(await findPendingHintSplits(10, new Date(LATER.getTime() + TEXT_DEBOUNCE_MS - 1))).toEqual([]);
    expect((await findPendingHintSplits(10, new Date(LATER.getTime() + TEXT_DEBOUNCE_MS))).map((article) => article.id)).toEqual([33]);
  });

  test("a hint split with the old key (raw content hash) is re-keyed when the text is unchanged", async () => {
    const oldContent = hintHtml;
    const newContent = hintHtml.replace("<div>", "<div class='trix'>");
    const oldHash = createHash("sha256").update(oldContent).digest("hex");
    // Split by the previous version: hintSplitHash = contentHash (with or without a textHash stored)
    await Article.collection.insertOne({ id: 34, title: "Article 34", type: "hint", publishAt: NOW, content: oldContent, contentHash: oldHash, hintSplitHash: oldHash });
    await Article.collection.insertOne({ id: 35, title: "Article 35", type: "hint", publishAt: NOW, content: oldContent, contentHash: oldHash, textHash: articleTextHash(oldContent), textChangedAt: NOW, hintSplitHash: oldHash });

    const result = await syncArticles([apiArticle(34, "hint", newContent), apiArticle(35, "hint", newContent)], { now: () => LATER });

    expect(result.changedHints).toEqual([]);
    for (const id of [34, 35]) expect((await stored(id)).hintSplitHash).toBe(hintSplitKey(articleTextHash(newContent)));
    expect(await findPendingHintSplits(10, new Date(LATER.getTime() + TEXT_DEBOUNCE_MS + 1))).toEqual([]);
  });

  test("a hint split of older content is not re-keyed", async () => {
    await Article.collection.insertOne({ id: 36, title: "Article 36", type: "hint", publishAt: NOW, content: "<div>oud</div>", contentHash: "oude-hash", hintSplitHash: "nog-oudere-hash" });
    await syncArticles([apiArticle(36, "hint", "<div>oud</div>")], { now: () => LATER });
    expect((await stored(36)).hintSplitHash).toBe("nog-oudere-hash");
  });

  test("a text change keeps the old summary until a new one is stored, and sets textChangedAt", async () => {
    await syncArticles([apiArticle(20, "news", "<div>Wissel om 23:00</div>")], { now: () => NOW });
    const { textHash } = await stored(20);
    await Article.updateOne({ id: 20 }, { $set: { summary: "Wissel om 23:00.", summaryHash: summaryKey(textHash!) } });

    await syncArticles([apiArticle(20, "news", "<div>Wissel om 22:00</div>")], { now: () => LATER });

    const changed = await stored(20);
    expect(changed.textHash).not.toBe(textHash);
    expect(changed.textChangedAt).toEqual(LATER);
    expect(changed).toMatchObject({ summary: "Wissel om 23:00.", summaryHash: summaryKey(textHash!) });
  });

  test("an unchanged article keeps its summary and textChangedAt", async () => {
    await syncArticles([apiArticle(21, "news", "<div>Wissel om 23:00</div>")], { now: () => NOW });
    const { textHash } = await stored(21);
    await Article.updateOne({ id: 21 }, { $set: { summary: "Wissel om 23:00.", summaryHash: summaryKey(textHash!) } });

    await syncArticles([apiArticle(21, "news", "<div>Wissel om 23:00</div>")], { now: () => LATER });

    expect(await stored(21)).toMatchObject({ summary: "Wissel om 23:00.", summaryHash: summaryKey(textHash!), textChangedAt: NOW });
  });

  test("a v2 summary of the unchanged content is re-keyed to the text hash (no new summary needed)", async () => {
    const content = "<div>Wissel om 23:00</div>";
    const contentHash = createHash("sha256").update(content).digest("hex");
    // Stored by the previous version: no text hash yet, a v2 summary of this very content
    await Article.collection.insertOne({ id: 23, title: "Article 23", type: "news", publishAt: NOW, content, contentHash, summary: "Wissel om 23:00.", summaryHash: legacySummaryKey(contentHash) });

    await syncArticles([apiArticle(23, "news", content)], { now: () => LATER });

    const article = await stored(23);
    expect(article.textHash).toBe(articleTextHash(content));
    expect(article).toMatchObject({ summary: "Wissel om 23:00.", summaryHash: summaryKey(articleTextHash(content)) });
    expect(article.textChangedAt!.getTime()).toBeLessThan(LATER.getTime() - SUMMARY_DEBOUNCE_MS);
  });

  test("a markup-only re-save of a legacy v2 article (no text hash) keeps and re-keys its summary", async () => {
    const oldContent = "<div>Wissel om 23:00</div>";
    const newContent = '<div class="trix-content">Wissel  om <strong>23:00</strong></div>';
    const oldHash = createHash("sha256").update(oldContent).digest("hex");
    await Article.collection.insertOne({ id: 25, title: "Article 25", type: "news", publishAt: NOW, content: oldContent, contentHash: oldHash, summary: "Wissel om 23:00.", summaryHash: legacySummaryKey(oldHash) });

    await syncArticles([apiArticle(25, "news", newContent)], { now: () => LATER });

    const article = await stored(25);
    expect(article).toMatchObject({ summary: "Wissel om 23:00.", summaryHash: summaryKey(articleTextHash(newContent)) });
    expect(article.textChangedAt!.getTime()).toBeLessThan(LATER.getTime() - SUMMARY_DEBOUNCE_MS);
  });

  test("a v2 summary of other content is not re-keyed; the old summary stays visible", async () => {
    await Article.collection.insertOne({ id: 24, title: "Article 24", type: "news", publishAt: NOW, content: "<div>oud</div>", contentHash: "oude-hash", summary: "Oud.", summaryHash: legacySummaryKey("oude-hash") });

    await syncArticles([apiArticle(24, "news", "<div>nieuw</div>")], { now: () => LATER });

    expect(await stored(24)).toMatchObject({ summary: "Oud.", summaryHash: legacySummaryKey("oude-hash"), textHash: articleTextHash("<div>nieuw</div>"), textChangedAt: LATER });
  });
});
