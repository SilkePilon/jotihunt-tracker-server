import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Article, publicArticlesFilter } from "../models/article.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("publicArticlesFilter", () => {
  test("returns articles newest first and excludes seeded test articles", async () => {
    await Article.create([
      { id: 1, title: "Oud", type: "news", publishAt: new Date("2026-10-17T12:00:00Z"), content: "a" },
      { id: 2, title: "Nieuw", type: "news", publishAt: new Date("2026-10-17T14:00:00Z"), content: "b" },
      { id: 900001, title: "Testhint", type: "hint", publishAt: new Date("2026-10-17T15:00:00Z"), content: "c" },
    ]);

    const articles = await Article.find(publicArticlesFilter()).sort({ publishAt: -1 });

    expect(articles.map((article) => article.id)).toEqual([2, 1]);
  });
});
