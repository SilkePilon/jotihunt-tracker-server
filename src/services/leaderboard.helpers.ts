import { startOfDay } from "./tracker-onboarding.helpers";

export const POINTS_PER_HUNT = 2;
export const POINTS_PER_HINT = 3;
export const KM_PER_POINT = 5;

export interface LeaderboardUser {
  id: string;
  name: string;
  /** Traccar device of the user's own "Mijn tracker" */
  deviceId?: number;
}
export interface LeaderboardReport {
  reportedBy: string;
  /** jotihunt.nl points once judged, else null */
  sitePoints: number | null;
}
export interface DeviceSummary {
  distanceM: number;
  maxSpeedKmh: number | null;
}
export interface DistanceWindow {
  from: Date;
  to: Date;
  kind: "hunt" | "today";
}
export interface LeaderboardInput {
  users: LeaderboardUser[];
  reports: LeaderboardReport[];
  /** One user id per solved hint cell */
  solvedBy: string[];
  summaries: Map<number, DeviceSummary>;
  distanceAvailable: boolean;
  window: DistanceWindow;
  now: Date;
}
export interface LeaderboardEntry {
  userId: string;
  name: string;
  rank: number;
  score: number;
  hunts: number;
  approvedHunts: number;
  huntPoints: number;
  hints: number;
  distanceKm: number;
  topSpeedKmh: number | null;
  breakdown: { hunts: number; huntPoints: number; hints: number; distance: number };
}
export interface Leaderboard {
  entries: LeaderboardEntry[];
  totals: { distanceKm: number; hunts: number; hints: number; fastest: { name: string; speedKmh: number } | null };
  distanceSince: string;
  distanceWindow: DistanceWindow["kind"];
  distanceAvailable: boolean;
  updatedAt: string;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

function validDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Hunt window once the hunt has started, otherwise today (so the board can be tried before the weekend). */
export function distanceWindow(now: Date, start: string | undefined, end: string | undefined): DistanceWindow {
  const from = validDate(start);
  if (!from || now.getTime() < from.getTime()) return { from: startOfDay(now), to: now, kind: "today" };
  const until = validDate(end);
  return { from, to: until && until.getTime() < now.getTime() ? until : now, kind: "hunt" };
}

export function buildLeaderboard(input: LeaderboardInput): Leaderboard {
  const unranked = input.users.map((user) => {
    const reports = input.reports.filter((report) => report.reportedBy === user.id);
    const huntPoints = reports.reduce((sum, report) => sum + (report.sitePoints ?? 0), 0);
    const hints = input.solvedBy.filter((id) => id === user.id).length;
    const summary = user.deviceId !== undefined ? input.summaries.get(user.deviceId) : undefined;
    const distanceKm = round1((summary?.distanceM ?? 0) / 1000);
    const breakdown = {
      hunts: reports.length * POINTS_PER_HUNT,
      huntPoints,
      hints: hints * POINTS_PER_HINT,
      distance: Math.floor((summary?.distanceM ?? 0) / 1000 / KM_PER_POINT),
    };
    return {
      userId: user.id,
      name: user.name,
      rank: 0,
      score: breakdown.hunts + breakdown.huntPoints + breakdown.hints + breakdown.distance,
      hunts: reports.length,
      approvedHunts: reports.filter((report) => (report.sitePoints ?? 0) > 0).length,
      huntPoints,
      hints,
      distanceKm,
      topSpeedKmh: summary?.maxSpeedKmh ?? null,
      breakdown,
    };
  });

  const entries = unranked.sort((a, b) => b.score - a.score || b.hunts - a.hunts || a.name.localeCompare(b.name, "nl"));
  entries.forEach((entry, index) => {
    entry.rank = index > 0 && entries[index - 1].score === entry.score ? entries[index - 1].rank : index + 1;
  });

  const fastest = entries
    .filter((entry) => entry.topSpeedKmh !== null)
    .reduce<LeaderboardEntry | null>((best, entry) => (!best || entry.topSpeedKmh! > best.topSpeedKmh! ? entry : best), null);

  return {
    entries,
    totals: {
      distanceKm: round1(entries.reduce((sum, entry) => sum + entry.distanceKm, 0)),
      hunts: input.reports.length,
      hints: input.solvedBy.length,
      fastest: fastest ? { name: fastest.name, speedKmh: fastest.topSpeedKmh! } : null,
    },
    distanceSince: input.window.from.toISOString(),
    distanceWindow: input.window.kind,
    distanceAvailable: input.distanceAvailable,
    updatedAt: input.now.toISOString(),
  };
}
