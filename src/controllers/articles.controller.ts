import { Article, publicArticlesFilter } from "../models/article.model";
import { Request, Response } from "express";
import { respond } from "../http/service-error";
import { getReadState, markArticleRead } from "../services/article-read.service";
import { sendCachedJson } from "../services/response-cache";

export { publicArticlesFilter };

export async function getArticles(_req: Request, res: Response) {
  // Articles are upserted in place (never wiped/reinserted), so natural insertion order
  // no longer reflects publish order. Sort explicitly so clients that assume the newest
  // article is first (e.g. NextHintTimeCard) keep working.
  // Polled by every hunter: one shared body for a moment (articles are only written by the sync cron)
  return sendCachedJson(res, "articles", () => Article.find(publicArticlesFilter()).sort({ publishAt: -1 }).lean());
}

/** The articles the caller read, and per article how many users read it */
export function getRead(req: Request, res: Response) {
  return respond(res, 200, () => getReadState(req.user!._id));
}

/** Remember that the caller opened an article */
export function markRead(req: Request, res: Response) {
  return respond(res, 204, () => markArticleRead(req.user!._id, Number(req.params.id)));
}
