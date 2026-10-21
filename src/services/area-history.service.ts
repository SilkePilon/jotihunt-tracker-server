import { AREA_STATUSES, type AreaName, areaTitle } from "../constants/areas";
import { Area } from "../models/area.model";
import { AreaStatusEvent } from "../models/area-status-event.model";
import { Article } from "../models/article.model";
import { HintCell, HintCellStatus } from "../models/hint-cell.model";
import { Hunt } from "../models/hunt.model";
import { Marker, MarkerType } from "../models/marker.model";

export const HISTORY_DEFAULT_MINUTES = 180;
const SPOT_LEAD_MS = 10 * 60_000;
const HUNT_COOLDOWN_MS = 60 * 60_000;
/** Hint cells published this long before the window are left out (old cells that were never marked solved) */
const HINT_LEAD_MS = 180 * 60_000;
const TEGENHUNT = /tegenhunt/i;

export interface AreaHistory {
  area: string;
  from: string;
  to: string;
  status: { status: "green" | "orange" | "red" | "blue"; from: string; to: string | null }[];
  hints: { articleId: number; publishAt: string; solvedAt: string | null; title: string }[];
  spots: { id: string; at: string }[];
  hunts: { id: string; at: string; result: "approved" | "pending" | "rejected" }[];
}

interface StatusPoint {
  status: string;
  at: Date;
}
const known = (status: string) => (AREA_STATUSES as readonly string[]).includes(status);
const clock = (date: Date) => date.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Amsterdam" });

/**
 * Status periods inside [from, to]: the last change at or before `from` (clipped to `from`) plus the changes inside,
 * equal neighbours merged, the last one still running (to: null). Without a change at or before `from` (events are
 * only stored since 2026-10-20) the area's current status counts from `from` when it has not changed since, else the
 * lane starts at the first change (or at `updatedAt` when there are no changes at all).
 */
export function statusPeriods(input: { before: StatusPoint | null; events: StatusPoint[]; current: { status: string; updatedAt: Date } | null; from: Date; to: Date }) {
  const { before, events, current, from } = input;
  const points: StatusPoint[] = [];
  if (before) points.push({ status: before.status, at: from });
  else if (current && events.length === 0) points.push({ status: current.status, at: current.updatedAt <= from ? from : current.updatedAt });
  points.push(...events.filter((event) => event.at > from || !before));
  const periods: { status: string; from: Date; to: Date | null }[] = [];
  for (const point of points.filter((p) => known(p.status)).sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const last = periods[periods.length - 1];
    if (last?.status === point.status) continue;
    if (last) last.to = point.at;
    periods.push({ status: point.status, from: point.at < from ? from : point.at, to: null });
  }
  return periods;
}

/**
 * What happened to one fox in the last `minutes`: status periods, hint cells (published → solved), sightings and our
 * synced hunts (from an hour before the window, so a running cooldown shows; tegenhunts left out). Null for an area
 * that is not in the database.
 */
export async function areaHistory(area: AreaName, minutes: number, now = new Date()): Promise<AreaHistory | null> {
  const to = now;
  const from = new Date(now.getTime() - minutes * 60_000);
  const title = areaTitle(area);
  const doc = await Area.findOne({ name: title }).lean();
  if (!doc) return null;

  // AreaStatusEvent.area is Area.name ("Alpha"), HintCell.area is lowercase; markers and hunts are written lowercase
  // today, matched case-insensitively in case older data isn't
  const anyCase = new RegExp(`^${area}$`, "i");
  const [before, events, cells, spots, hunts] = await Promise.all([
    AreaStatusEvent.findOne({ area: title, at: { $lte: from } })
      .sort({ at: -1 })
      .lean(),
    AreaStatusEvent.find({ area: title, at: { $gt: from, $lte: to } })
      .sort({ at: 1 })
      .lean(),
    HintCell.find({
      area,
      status: { $ne: HintCellStatus.None },
      publishAt: { $gte: new Date(from.getTime() - HINT_LEAD_MS), $lt: to },
      // Solved cells without a solvedAt (solved before the field existed) are left out: their time is unknown
      $or: [{ status: HintCellStatus.Open }, { solvedAt: { $gte: from } }],
    })
      .sort({ publishAt: 1 })
      .lean(),
    Marker.find({ type: MarkerType.Spot, area: anyCase, time: { $gte: new Date(from.getTime() - SPOT_LEAD_MS), $lte: to } })
      .sort({ time: 1 })
      .lean(),
    Hunt.find({ area: anyCase, huntTime: { $gte: new Date(from.getTime() - HUNT_COOLDOWN_MS), $lte: to }, statusText: { $not: TEGENHUNT }, status: { $not: TEGENHUNT } })
      .sort({ huntTime: 1 })
      .lean(),
  ]);
  const titles = new Map((await Article.find({ id: { $in: cells.map((cell) => cell.articleId) } }, { id: 1, title: 1 }).lean()).map((article) => [article.id, article.title]));

  const periods = statusPeriods({ before, events, current: { status: doc.status, updatedAt: doc.updatedAt }, from, to });
  return {
    area,
    from: from.toISOString(),
    to: to.toISOString(),
    status: periods.map((period) => ({ status: period.status as AreaHistory["status"][number]["status"], from: period.from.toISOString(), to: period.to?.toISOString() ?? null })),
    hints: cells.map((cell) => ({
      articleId: cell.articleId,
      publishAt: cell.publishAt.toISOString(),
      solvedAt: cell.status === HintCellStatus.Solved && cell.solvedAt ? cell.solvedAt.toISOString() : null,
      title: titles.get(cell.articleId) ?? `Hint ${clock(cell.slotTime)}`,
    })),
    spots: spots.map((marker) => ({ id: String(marker._id), at: marker.time.toISOString() })),
    hunts: hunts.map((hunt) => ({
      id: String(hunt._id),
      at: hunt.huntTime!.toISOString(),
      result: hunt.statusClass === "approved" || hunt.statusClass === "rejected" ? hunt.statusClass : "pending",
    })),
  };
}
