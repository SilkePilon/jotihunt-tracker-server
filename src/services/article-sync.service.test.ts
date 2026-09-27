import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Article } from "../models/article.model";
import { Area } from "../models/area.model";
import { HintCell, HintCellStatus } from "../models/hint-cell.model";
import { ApiArticle } from "../types/api";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { floorToHour, syncArticles } from "./article-sync.service";

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

  test("flags cells when a hint article changes after publication", async () => {
    await syncArticles([apiArticle(7, "hint", hintHtml)]);
    await HintCell.updateOne({ articleId: 7, area: "alpha" }, { $set: { answer: "1234 5678" } });
    const result = await syncArticles([apiArticle(7, "hint", hintHtml + "<p>correctie</p>")]);
    expect(result.changedHints).toEqual([7]);
    const cells = await HintCell.find({ articleId: 7 }).lean();
    expect(cells.every((cell) => cell.articleChanged)).toBe(true);
    expect(cells.find((cell) => cell.area === "alpha")!.answer).toBe("1234 5678");
  });
});
