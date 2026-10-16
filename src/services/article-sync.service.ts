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
export async function ensureHintCells(article: { id: number; publishAt: Date; content: string }, areaNames?: string[]): Promise<number> {
  areaNames ??= await getAreaNames();
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

/** The stored fields syncArticles reads or writes */
const STORED_FIELDS = {
  _id: 0,
  id: 1,
  title: 1,
  type: 1,
  publishAt: 1,
  content: 1,
  messageType: 1,
  maxPoints: 1,
  endTime: 1,
  contentHash: 1,
  textHash: 1,
  summaryHash: 1,
  hintSplitHash: 1,
} as const;

/**
 * True when writing `fields` would change nothing: every value, cast like the update casts it, equals the stored one.
 * Mongoose drops undefined values from a $set (the field is left alone); a null is stored as null.
 */
function isStored(previous: Record<string, unknown>, fields: Record<string, unknown>): boolean {
  const cast = Article.castObject(fields) as Record<string, unknown>;
  return Object.keys(fields).every((key) => {
    const raw = fields[key];
    const current = previous[key];
    if (raw === undefined) return true;
    if (raw === null) return current === null;
    const next = cast[key];
    if (next instanceof Date) return current instanceof Date && current.getTime() === next.getTime();
    return next !== undefined && current === next;
  });
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

  // The stored articles in one query; a failed lookup falls back to one query per article (which then fails that article)
  const stored = await Article.find({ id: { $in: apiArticles.map((article) => article.id) } }, STORED_FIELDS)
    .lean()
    .then((articles) => new Map(articles.map((article) => [article.id, article])))
    .catch(() => null);
  // Ids written by this run: an id the API lists twice is read again, so it sees the first write
  const written = new Set<number>();
  // Area names once per run (on the first hint article); a failed lookup is retried for the next one
  let areaNames: string[] | undefined;

  for (const apiArticle of apiArticles) {
    try {
      const content = apiArticle.message.content;
      const contentHash = hashContent(content);
      const publishAt = new Date(apiArticle.publish_at);
      if (isNaN(publishAt.getTime())) throw new Error(`Invalid publish_at: ${apiArticle.publish_at}`);

      const textHash = articleTextHash(content);
      const previous =
        stored && !written.has(apiArticle.id) ? (stored.get(apiArticle.id) ?? null) : await Article.findOne({ id: apiArticle.id }, STORED_FIELDS).lean();
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

      const fields = {
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
      };
      // Most runs change nothing: skip the write when every field already has this value
      if (!previous || !isStored(previous, fields)) {
        await Article.updateOne({ id: apiArticle.id }, { $set: fields }, { upsert: true });
        written.add(apiArticle.id);
      }
      result.upserted++;

      // Only a changed text (or file) counts: a markup-only re-save in the organisation's editor flags nothing
      const changed = Boolean(previous?.contentHash) && previousTextHash !== textHash;

      if (apiArticle.type !== "hint") continue;

      if (changed) {
        await HintCell.updateMany({ articleId: apiArticle.id }, { $set: { articleChanged: true } });
        result.changedHints.push(apiArticle.id);
      }

      areaNames ??= await getAreaNames();
      result.cellsCreated += await ensureHintCells({ id: apiArticle.id, publishAt, content }, areaNames);
    } catch {
      // Services must not import the logger; the cron logs a warning with these ids.
      result.failed.push(apiArticle.id);
    }
  }

  return result;
}
