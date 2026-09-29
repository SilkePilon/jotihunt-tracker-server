import { describe, expect, test } from "bun:test";
import path from "node:path";
import type { ApiArticle } from "../../types/api";
import { demoHuntStart, retimeArticles } from "./articles";

const { articles } = (await Bun.file(path.join(import.meta.dir, "..", "data", "articles-2025.json")).json()) as { articles: ApiArticle[] };

describe("demo articles", () => {
  test("hunt start is 6 hours before now, on the hour", () => {
    expect(demoHuntStart(new Date("2026-10-17T15:42:10Z")).toISOString()).toBe("2026-10-17T09:00:00.000Z");
  });

  for (const nowIso of ["2026-10-17T15:00:00Z", "2026-10-17T15:59:59Z", "2026-10-18T00:30:00Z"]) {
    test(`re-timed: hints on the hour from hunt start, ids offset, nothing after now (${nowIso})`, () => {
      const now = new Date(nowIso);
      const huntStart = demoHuntStart(now);
      const retimed = retimeArticles(articles, huntStart);
      expect(retimed).toHaveLength(15);
      const hints = retimed.filter((article) => article.type === "hint");
      expect(hints.map((hint) => (new Date(hint.publish_at).getTime() - huntStart.getTime()) / 3_600_000)).toEqual([0, 1, 2, 3, 4, 5]);
      // oldest hint = earliest
      expect(hints.map((hint) => hint.id - 800000)).toEqual([31, 48, 72, 54, 33, 61]);
      for (const article of retimed) {
        expect(article.id).toBeGreaterThan(800000);
        expect(new Date(article.publish_at).getTime()).toBeLessThanOrEqual(now.getTime());
      }
      const assignment = retimed.find((article) => article.id === 800049)!;
      expect(new Date(assignment.message.end_time).getTime() - new Date(assignment.publish_at).getTime()).toBe(50 * 60_000);
    });
  }
});
