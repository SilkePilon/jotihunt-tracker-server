import { Article, publicArticlesFilter } from "../models/article.model";
import { Assignment, AssignmentStatus } from "../models/assignment.model";
import { isDuplicateKeyError } from "../utils/mongo";
import type { SiteSubmission } from "./jotihunt-assignment.parse";

/** Assignment pages opened per run at most */
export const PAGES_PER_RUN = 5;

/**
 * The published assignments whose jotihunt.nl page should be (re)checked, at most `limit`: judged ones never again;
 * never checked first, then the longest ago, newest first among equals (so with many open assignments every page is
 * still checked in turn).
 */
export async function assignmentsToCheck(now = new Date(), limit = PAGES_PER_RUN): Promise<number[]> {
  const judged = await Assignment.distinct("articleId", { "site.judged": true });
  const articles = await Article.find({ type: "assignment", publishAt: { $lte: now }, id: { ...publicArticlesFilter().id, $nin: judged } }, { _id: 0, id: 1, publishAt: 1 })
    .sort({ publishAt: -1, id: -1 })
    .lean();
  const checked = new Map(
    (await Assignment.find({ articleId: { $in: articles.map((article) => article.id) }, site: { $ne: null } }, { _id: 0, articleId: 1, "site.checkedAt": 1 }).lean()).map((assignment) => [
      assignment.articleId,
      assignment.site?.checkedAt?.getTime() ?? 0,
    ]),
  );
  // A stable sort keeps newest first among equal check times
  return articles
    .map((article) => ({ id: article.id, checkedAt: checked.get(article.id) ?? -1 }))
    .sort((a, b) => a.checkedAt - b.checkedAt)
    .slice(0, limit)
    .map((article) => article.id);
}

/**
 * Store what an assignment page showed (creating the bookkeeping document when missing). Handed in while our status is
 * open or busy: the status becomes submitted by jotihunt.nl (statusBy null); submitted or skipped set by people stays.
 * Returns whether the status changed.
 */
export async function storeSubmission(articleId: number, page: Omit<SiteSubmission, "found">, now = new Date()): Promise<boolean> {
  const site = { submitted: page.submitted, imageUrl: page.imageUrl, rating: page.rating, judgement: page.judgement, judged: page.judged, points: page.points, checkedAt: now };
  try {
    await Assignment.updateOne({ articleId }, { $set: { site }, $setOnInsert: { articleId } }, { upsert: true });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    // A concurrent first write created it
    await Assignment.updateOne({ articleId }, { $set: { site } });
  }
  if (!page.submitted) return false;
  const result = await Assignment.updateOne(
    { articleId, status: { $in: [AssignmentStatus.Open, AssignmentStatus.Busy] } },
    { $set: { status: AssignmentStatus.Submitted, statusBy: null, statusAt: now } },
  );
  return result.modifiedCount > 0;
}
