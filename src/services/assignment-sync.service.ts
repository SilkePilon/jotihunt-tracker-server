import { Article, publicArticlesFilter } from "../models/article.model";
import { Assignment, AssignmentStatus } from "../models/assignment.model";
import { isDuplicateKeyError } from "../utils/mongo";
import type { SiteSubmission } from "./jotihunt-assignment.parse";

/** Assignment pages opened per run at most */
export const PAGES_PER_RUN = 5;

/**
 * The published assignments whose jotihunt.nl page should be (re)checked, at most `limit`: judged ones never again;
 * never tried first, then the longest ago (a failed try counts, so failing pages cannot starve the rest), newest first
 * among equals.
 */
export async function assignmentsToCheck(now = new Date(), limit = PAGES_PER_RUN): Promise<number[]> {
  const judged = await Assignment.distinct("articleId", { "site.judged": true });
  const articles = await Article.find({ type: "assignment", publishAt: { $lte: now }, id: { ...publicArticlesFilter().id, $nin: judged } }, { _id: 0, id: 1, publishAt: 1 })
    .sort({ publishAt: -1, id: -1 })
    .lean();
  const tried = new Map(
    (await Assignment.find({ articleId: { $in: articles.map((article) => article.id) } }, { _id: 0, articleId: 1, siteAttemptAt: 1, "site.checkedAt": 1 }).lean()).map((assignment) => [
      assignment.articleId,
      Math.max(assignment.siteAttemptAt?.getTime() ?? -1, assignment.site?.checkedAt?.getTime() ?? -1),
    ]),
  );
  // A stable sort keeps newest first among equal times
  return articles
    .map((article) => ({ id: article.id, triedAt: tried.get(article.id) ?? -1 }))
    .sort((a, b) => a.triedAt - b.triedAt)
    .slice(0, limit)
    .map((article) => article.id);
}

/** Note a try of the page (before it is fetched), creating the bookkeeping document when missing */
export async function markSiteAttempt(articleId: number, now = new Date()): Promise<void> {
  try {
    await Assignment.updateOne({ articleId }, { $set: { siteAttemptAt: now }, $setOnInsert: { articleId } }, { upsert: true });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    await Assignment.updateOne({ articleId }, { $set: { siteAttemptAt: now } });
  }
}

/**
 * Store what an assignment page showed (creating the bookkeeping document when missing). Handed in while our status is
 * open or busy: the status becomes submitted by jotihunt.nl (statusBy null); submitted or skipped set by people stays.
 * Returns whether the status changed.
 */
export async function storeSubmission(articleId: number, page: Omit<SiteSubmission, "found">, now = new Date()): Promise<boolean> {
  const site = { submitted: page.submitted, imageUrl: page.imageUrl, answerText: page.answerText, rating: page.rating, judgement: page.judgement, judged: page.judged, points: page.points, checkedAt: now };
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
