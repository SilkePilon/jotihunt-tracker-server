import { describe, expect, test } from "bun:test";
import type { ArticlesPage } from "../services/jotihunt.service";
import type { ApiArticle } from "../types/api";
import { fetchNewArticles, MAX_ARTICLE_PAGES } from "./jotihunt-articles.cron";

const article = (id: number) => ({ id, title: `A${id}`, type: "news", publish_at: "2026-10-17T10:00:00.000000Z", message: { content: "c" } }) as ApiArticle;

/** `total` articles, newest (highest id) first, 15 per page */
function api(total: number, failPage?: number) {
  const requested: number[] = [];
  const fetchPage = async (page: number): Promise<ArticlesPage> => {
    requested.push(page);
    if (page === failPage) throw new Error("boom");
    const ids = Array.from({ length: total }, (_, index) => total - index).slice((page - 1) * 15, page * 15);
    return { articles: ids.map(article), lastPage: Math.max(1, Math.ceil(total / 15)), perPage: 15 };
  };
  return { fetchPage, requested };
}

const knownUpTo = (maxId: number) => async (ids: unknown[]) => new Set((ids as number[]).filter((id) => id <= maxId));

describe("fetchNewArticles", () => {
  test("page 1 only when it has a known article", async () => {
    const { fetchPage, requested } = api(40);
    const articles = await fetchNewArticles(fetchPage, knownUpTo(30));
    expect(requested).toEqual([1]);
    expect(articles).toHaveLength(15);
  });

  test("more pages while every article of a full page is new (outage / first run)", async () => {
    const { fetchPage, requested } = api(40);
    const articles = await fetchNewArticles(fetchPage, knownUpTo(12));
    expect(requested).toEqual([1, 2]);
    expect(articles.map((item) => item.id)).toContain(26);
  });

  test("stops at the last page and at MAX_ARTICLE_PAGES", async () => {
    const few = api(20);
    expect(await fetchNewArticles(few.fetchPage, knownUpTo(0))).toHaveLength(20);
    expect(few.requested).toEqual([1, 2]);

    const many = api(200);
    expect(await fetchNewArticles(many.fetchPage, knownUpTo(0))).toHaveLength(MAX_ARTICLE_PAGES * 15);
    expect(many.requested).toHaveLength(MAX_ARTICLE_PAGES);
  });

  test("a failing later page keeps what was fetched; a failing page 1 throws", async () => {
    const later = api(40, 2);
    expect(await fetchNewArticles(later.fetchPage, knownUpTo(0))).toHaveLength(15);
    const first = api(40, 1);
    await expect(fetchNewArticles(first.fetchPage, knownUpTo(0))).rejects.toThrow("boom");
  });
});
