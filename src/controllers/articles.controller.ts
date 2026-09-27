import { Article } from "../models/article.model";
import { Request, Response } from "express";

// Seeded test hint articles use ids >= 900000 (see src/scripts/seed-hint.ts) and are
// excluded from the public list.
export function publicArticlesFilter() {
  return { id: { $lt: 900000 } };
}

export async function getArticles(_req: Request, res: Response) {
  // Articles are upserted in place (never wiped/reinserted), so natural insertion order
  // no longer reflects publish order. Sort explicitly so clients that assume the newest
  // article is first (e.g. NextHintTimeCard) keep working.
  const articles = await Article.find(publicArticlesFilter()).sort({ publishAt: -1 });
  return res.status(200).json(articles);
}
