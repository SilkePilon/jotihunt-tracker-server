import { createHash } from "node:crypto";
import { Article } from "../models/article.model";
import { Area } from "../models/area.model";
import { HintCell, HintCellStatus } from "../models/hint-cell.model";
import { ApiArticle } from "../types/api";
import { DEFAULT_AREAS, parseHintArticle } from "./hint-parser";

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

function hashContent(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

async function getAreaNames(): Promise<string[]> {
  const areas = await Area.find({}, { name: 1 }).lean();
  const names = areas.map((area) => area.name.toLowerCase()).filter((name) => DEFAULT_AREAS.includes(name));
  return names.length ? names : DEFAULT_AREAS;
}

/**
 * Create the per-area cells for a hint article that don't exist yet.
 *
 * The areas cron rewrites the Area collection (deleteMany + insertMany) every 10s, so a read
 * here can observe a partial list. Rather than bail out entirely once any cell exists (which
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
    if ((error as { code?: number }).code !== 11000) throw error;
    return await HintCell.countDocuments({ articleId: article.id, area: { $in: missingAreas } });
  }
  return cells.length;
}

/**
 * Upsert articles from the Jotihunt API (never deletes, so older hints are kept),
 * create hint cells for new hint articles and flag cells of edited hint articles.
 */
export async function syncArticles(apiArticles: ApiArticle[]): Promise<SyncResult> {
  const result: SyncResult = { upserted: 0, changedHints: [], cellsCreated: 0, failed: [] };

  for (const apiArticle of apiArticles) {
    try {
      const content = apiArticle.message.content;
      const contentHash = hashContent(content);
      const publishAt = new Date(apiArticle.publish_at);
      if (isNaN(publishAt.getTime())) throw new Error(`Invalid publish_at: ${apiArticle.publish_at}`);

      const previous = await Article.findOneAndUpdate(
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
          },
        },
        { upsert: true },
      ).lean();
      result.upserted++;

      if (apiArticle.type !== "hint") continue;

      if (previous?.contentHash && previous.contentHash !== contentHash) {
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
