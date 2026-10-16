import { HuntReport } from "../models/hunt-report.model";
import { effectiveHuntTime, HUNT_AREAS, normalizeHuntCode } from "./hunt-report.helpers";
import { compareAge } from "./hunt-report.view";

export interface ScrapedHunt {
  huntCode: string | null;
  status: string | null;
  points: number;
  /** Needed to link hunts without a code (QR flow) by fox and time */
  area?: string | null;
  /** The hunt time as parsed from the site; null when unknown */
  time?: Date | null;
}

/** A report without a code links to a scraped hunt of the same fox within this distance of its hunt time. */
export const TIME_MATCH_WINDOW_MS = 15 * 60 * 1000;

const siteOf = (hunt: ScrapedHunt, now: Date) => ({ status: (hunt.status ?? "").trim(), points: Number.isFinite(hunt.points) ? hunt.points : 0, seenAt: now });

/**
 * Copy the status and points of scraped jotihunt.nl hunts to the app's reports. Returns how many reports were updated.
 *
 * 1. By code: the report with the same normalised code (the oldest one when a code was reported twice). One query for
 *    all codes and one ordered bulk write, so a code scraped twice ends with the last hunt's values.
 * 2. By fox and time: a report without a code (QR flow, or an unread photo), or with a code the site does not list,
 *    links to the closest scraped hunt that no report claimed by code, of the same area with a hunt time within
 *    ±15 minutes. Several reports may link to the same hunt (two hunters reporting the same contact).
 */
export async function linkScrapedHunts(hunts: ScrapedHunt[], now = new Date()): Promise<number> {
  const linked = hunts.flatMap((hunt) => {
    const huntCode = hunt.huntCode ? normalizeHuntCode(hunt.huntCode) : "";
    return huntCode ? [{ hunt, huntCode }] : [];
  });

  const operations: { updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> } }[] = [];
  const claimedByCode = new Set<ScrapedHunt>();
  if (linked.length > 0) {
    const reports = await HuntReport.find({ huntCode: { $in: [...new Set(linked.map(({ huntCode }) => huntCode))] } })
      .select("_id huntCode createdAt")
      .lean();
    const firstByCode = new Map<string, (typeof reports)[number]>();
    for (const report of reports.sort(compareAge)) {
      if (report.huntCode && !firstByCode.has(report.huntCode)) firstByCode.set(report.huntCode, report);
    }
    for (const { hunt, huntCode } of linked) {
      const first = firstByCode.get(huntCode);
      if (!first) continue;
      claimedByCode.add(hunt);
      // The code in the filter too: a code changed by HQ meanwhile must not get the old code's result
      operations.push({ updateOne: { filter: { _id: first._id, huntCode }, update: { $set: { site: siteOf(hunt, now) } } } });
    }
  }

  const scrapedCodes = [...new Set(linked.map(({ huntCode }) => huntCode))];
  operations.push(...(await timeMatches(hunts.filter((hunt) => !claimedByCode.has(hunt)), scrapedCodes, now)));
  if (operations.length === 0) return 0;
  const result = await HuntReport.bulkWrite(operations, { ordered: true });
  return result.modifiedCount;
}

/**
 * Updates linking reports to scraped hunts by fox and time (see linkScrapedHunts). Candidates: reports without a code,
 * and reports whose code the site does not list (misread, or the site shows no codes).
 */
async function timeMatches(hunts: ScrapedHunt[], scrapedCodes: string[], now: Date) {
  const timed = hunts.flatMap((hunt) => (hunt.area && hunt.time && !Number.isNaN(hunt.time.getTime()) ? [{ hunt, area: hunt.area.trim().toLowerCase(), time: hunt.time.getTime() }] : []));
  if (timed.length === 0) return [];
  const earliest = Math.min(...timed.map(({ time }) => time)) - TIME_MATCH_WINDOW_MS;
  const latest = Math.max(...timed.map(({ time }) => time)) + TIME_MATCH_WINDOW_MS;
  const range = { $gte: new Date(earliest), $lte: new Date(latest) };
  const reports = await HuntReport.find({
    huntCode: { $nin: scrapedCodes },
    area: { $in: [...new Set(timed.map(({ area }) => area))] as (typeof HUNT_AREAS)[number][] },
    // The effective hunt time (see effectiveHuntTime) within reach of a scraped hunt
    $or: [{ huntTime: range }, { huntTime: null, takenAt: range }, { huntTime: null, takenAt: null, createdAt: range }],
  })
    .select("_id area huntCode huntTime takenAt createdAt")
    .lean();

  // Every report takes its closest scraped hunt (ties: the first row); a hunt may link several reports (two hunters
  // reporting the same fox contact)
  return reports.flatMap((report) => {
    const time = effectiveHuntTime(report).getTime();
    let best: { hunt: ScrapedHunt; distance: number } | null = null;
    for (const scraped of timed) {
      if (scraped.area !== report.area) continue;
      const distance = Math.abs(time - scraped.time);
      if (distance <= TIME_MATCH_WINDOW_MS && (!best || distance < best.distance)) best = { hunt: scraped.hunt, distance };
    }
    if (!best) return [];
    // The code in the filter too: a code entered or changed by HQ meanwhile must not get this result
    return [{ updateOne: { filter: { _id: report._id, huntCode: report.huntCode ?? null }, update: { $set: { site: siteOf(best.hunt, now) } } } }];
  });
}
