import { Article, hintSplitKey, legacySummaryKey, SUMMARY_DEBOUNCE_MS, summaryKey } from "../models/article.model";
import { Area } from "../models/area.model";
import { HintCell, HintCellStatus } from "../models/hint-cell.model";
import { ApiArticle } from "../types/api";
import { articleTextHash, hashContent } from "./article-text-hash";
import { DEFAULT_AREAS, parseHintArticle } from "./hint-parser";
import { isDuplicateKeyError } from "../utils/mongo";

export interface SyncResult {
  upserted: number;
  changedHints: number[];
  cellsCreated: number;
  failed: number[];
}

export function floorToHour(date: Date): Date {
  const floored = new Date(date);
  floored.setUTCMinutes(0, 0, 0);
  return floored;
}

/** Lowercase names of the known areas in the Area collection; all default areas when none is stored yet */
export async function getAreaNames(): Promise<string[]> {
  const areas = await Area.find({}, { name: 1 }).lean();
  const names = areas.map((area) => area.name.toLowerCase()).filter((name) => DEFAULT_AREAS.includes(name));
  return names.length ? names : DEFAULT_AREAS;
}

/**
 * Create the per-area cells for a hint article that don't exist yet.
 *
 * The Area collection can be incomplete (e.g. before the first /areas answer was stored). Rather than bail out entirely once any cell exists (which
 * would leave the missing areas never backfilled), only the areas still missing a cell are
 * created.
 * @returns The number of cells created
 */
export async function ensureHintCells(article: { id: number; publishAt: Date; content: string }): Promise<number> {
  const areaNames = await getAreaNames();
  const existing = await HintCell.find({ articleId: article.id }, { area: 1 }).lean();
  const existingAreas = new Set(existing.map((cell) => cell.area));
  const missingAreas = areaNames.filter((area) => !existingAreas.has(area));
  if (missingAreas.length === 0) return 0;

  const parsed = parseHintArticle(article.content, areaNames);
  const cells = missingAreas.map((area) => {
    const part = parsed[area];
    return {
      articleId: article.id,
      area,
      publishAt: article.publishAt,
      slotTime: floorToHour(article.publishAt),
      snippet: part?.snippet ?? undefined,
      status: part?.none ? HintCellStatus.None : HintCellStatus.Open,
    };
  });

  try {
    await HintCell.insertMany(cells, { ordered: false });
  } catch (error) {
    // Duplicate key: another run created some of these cells concurrently. insertMany with
    // ordered: false still inserts the non-conflicting documents, so report how many of the
    // areas we attempted actually ended up with a cell.
    if (!isDuplicateKeyError(error)) throw error;
    return await HintCell.countDocuments({ articleId: article.id, area: { $in: missingAreas } });
  }
  return cells.length;
}

/**
 * Upsert articles from the Jotihunt API (never deletes, so older hints are kept),
 * create hint cells for new hint articles and flag cells of hint articles whose text changed.
 *
 * Summaries follow textHash (text and files, not markup): textChangedAt is set when it changes, and the old summary
 * stays until the summary job (after the debounce) stores a new one. A v2 summary of the unchanged content is re-keyed,
 * and so is a hint split keyed on the raw HTML when the text is unchanged (hint splits follow textHash too).
 */
export async function syncArticles(apiArticles: ApiArticle[], { now = () => new Date() }: { now?: () => Date } = {}): Promise<SyncResult> {
  const result: SyncResult = { upserted: 0, changedHints: [], cellsCreated: 0, failed: [] };

  for (const apiArticle of apiArticles) {
    try {
      const content = apiArticle.message.content;
      const contentHash = hashContent(content);
      const publishAt = new Date(apiArticle.publish_at);
      if (isNaN(publishAt.getTime())) throw new Error(`Invalid publish_at: ${apiArticle.publish_at}`);

      const textHash = articleTextHash(content);
      const previous = await Article.findOne({ id: apiArticle.id }, { _id: 0, contentHash: 1, content: 1, textHash: 1, summaryHash: 1, hintSplitHash: 1 }).lean();
      const time = now();
      // The text hash of the stored article (computed for one stored before textHash existed)
      const previousTextHash = previous?.textHash ?? (typeof previous?.content === "string" ? articleTextHash(previous.content) : undefined);
      // Stored by the version before textHash, with a summary of this very content: still current (same HTML or same text), so re-key it
      const rekey =
        Boolean(previous?.contentHash) &&
        previous?.summaryHash === legacySummaryKey(previous?.contentHash ?? "") &&
        (previous?.contentHash === contentHash || (!previous?.textHash && previousTextHash === textHash));
      // Hint split by the version keyed on the raw HTML, of the stored content, and the text is the same: re-key it
      const rekeySplit = Boolean(previous?.contentHash) && previous?.hintSplitHash === previous?.contentHash && previousTextHash === textHash;
      const textFields =
        previous?.textHash === textHash
          ? {}
          : { textHash, textChangedAt: (rekey || rekeySplit) && !previous?.textHash ? new Date(time.getTime() - SUMMARY_DEBOUNCE_MS - 1) : time };

      await Article.updateOne(
        { id: apiArticle.id },
        {
          $set: {
            title: apiArticle.title,
            type: apiArticle.type,
            publishAt,
            content,
            messageType: apiArticle.message.type,
            maxPoints: apiArticle.message.max_points,
            endTime: apiArticle.message.end_time,
            contentHash,
            ...textFields,
            ...(rekey ? { summaryHash: summaryKey(textHash) } : {}),
            ...(rekeySplit ? { hintSplitHash: hintSplitKey(textHash) } : {}),
          },
        },
        { upsert: true },
      );
      result.upserted++;

      // Only a changed text (or file) counts: a markup-only re-save in the organisation's editor flags nothing
      const changed = Boolean(previous?.contentHash) && previousTextHash !== textHash;

      if (apiArticle.type !== "hint") continue;

      if (changed) {
        await HintCell.updateMany({ articleId: apiArticle.id }, { $set: { articleChanged: true } });
        result.changedHints.push(apiArticle.id);
      }

      result.cellsCreated += await ensureHintCells({ id: apiArticle.id, publishAt, content });
    } catch {
      // Services must not import the logger; the cron logs a warning with these ids.
      result.failed.push(apiArticle.id);
    }
  }

  return result;
}
