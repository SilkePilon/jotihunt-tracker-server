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
  return areas.length ? areas.map((area) => area.name.toLowerCase()) : DEFAULT_AREAS;
}

/**
 * Create the per-area cells for a hint article, if they don't exist yet.
 * @returns The number of cells created
 */
export async function ensureHintCells(article: { id: number; publishAt: Date; content: string }): Promise<number> {
  if (await HintCell.exists({ articleId: article.id })) return 0;

  const parsed = parseHintArticle(article.content, await getAreaNames());
  const cells = Object.entries(parsed).map(([area, part]) => ({
    articleId: article.id,
    area,
    publishAt: article.publishAt,
    slotTime: floorToHour(article.publishAt),
    snippet: part.snippet ?? undefined,
    status: part.none ? HintCellStatus.None : HintCellStatus.Open,
  }));

  try {
    await HintCell.insertMany(cells, { ordered: false });
  } catch (error) {
    // Duplicate key: another run created the cells at the same time
    if ((error as { code?: number }).code !== 11000) throw error;
    return 0;
  }
  return cells.length;
}

/**
 * Upsert articles from the Jotihunt API (never deletes, so older hints are kept),
 * create hint cells for new hint articles and flag cells of edited hint articles.
 */
export async function syncArticles(apiArticles: ApiArticle[]): Promise<SyncResult> {
  const result: SyncResult = { upserted: 0, changedHints: [], cellsCreated: 0 };

  for (const apiArticle of apiArticles) {
    const content = apiArticle.message.content;
    const contentHash = hashContent(content);
    const publishAt = new Date(apiArticle.publish_at);

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
  }

  return result;
}
