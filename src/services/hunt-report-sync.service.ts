import { HuntReport } from "../models/hunt-report.model";
import { normalizeHuntCode } from "./hunt-report.helpers";
import { compareAge } from "./hunt-report.view";

export interface ScrapedHunt {
  huntCode: string | null;
  status: string | null;
  points: number;
}

/**
 * Copy the status and points of scraped jotihunt.nl hunts to the report with the same normalised code (the oldest
 * one when a code was reported twice; reports without a code can't link). Returns how many reports were updated.
 * One query for all codes and one ordered bulk write (one update per hunt, in order), so a code scraped twice
 * ends with the last hunt's values, as before.
 */
export async function linkScrapedHunts(hunts: ScrapedHunt[], now = new Date()): Promise<number> {
  const linked = hunts.flatMap((hunt) => {
    const huntCode = hunt.huntCode ? normalizeHuntCode(hunt.huntCode) : "";
    return huntCode ? [{ hunt, huntCode }] : [];
  });
  if (linked.length === 0) return 0;

  const reports = await HuntReport.find({ huntCode: { $in: [...new Set(linked.map(({ huntCode }) => huntCode))] } })
    .select("_id huntCode createdAt")
    .lean();
  const firstByCode = new Map<string, (typeof reports)[number]>();
  for (const report of reports.sort(compareAge)) {
    if (report.huntCode && !firstByCode.has(report.huntCode)) firstByCode.set(report.huntCode, report);
  }

  const operations = linked.flatMap(({ hunt, huntCode }) => {
    const first = firstByCode.get(huntCode);
    if (!first) return [];
    const site = { status: (hunt.status ?? "").trim(), points: Number.isFinite(hunt.points) ? hunt.points : 0, seenAt: now };
    // The code in the filter too: a code changed by HQ meanwhile must not get the old code's result
    return [{ updateOne: { filter: { _id: first._id, huntCode }, update: { $set: { site } } } }];
  });
  if (operations.length === 0) return 0;
  const result = await HuntReport.bulkWrite(operations, { ordered: true });
  return result.modifiedCount;
}
