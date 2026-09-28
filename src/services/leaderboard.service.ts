import { HintCell, HintCellStatus } from "../models/hint-cell.model";
import { HuntReport } from "../models/hunt-report.model";
import { User } from "../models/user.model";
import type { TraccarApi } from "./traccar-api";
import { buildLeaderboard, distanceWindow, type DeviceSummary, type Leaderboard } from "./leaderboard.helpers";

const KNOTS_TO_KMH = 1.852;
const CACHE_MS = 60_000;

export interface LeaderboardDeps {
  /** null when Traccar is not configured */
  api: TraccarApi | null;
  huntStart?: string;
  huntEnd?: string;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

export function createLeaderboardService(deps: LeaderboardDeps) {
  const now = deps.now ?? (() => new Date());
  let cache: { at: number; value: Leaderboard } | null = null;

  async function summaries(deviceIds: number[], from: Date, to: Date): Promise<{ map: Map<number, DeviceSummary>; available: boolean }> {
    const map = new Map<number, DeviceSummary>();
    if (!deps.api) return { map, available: false };
    const api = deps.api;
    let available = true;
    await Promise.all(
      deviceIds.map(async (deviceId) => {
        try {
          const summary = await api.getSummary(deviceId, from, to);
          if (summary) map.set(deviceId, { distanceM: summary.distance, maxSpeedKmh: summary.maxSpeed === null ? null : Math.round(summary.maxSpeed * KNOTS_TO_KMH) });
        } catch (error) {
          available = false;
          deps.onError?.(error);
        }
      }),
    );
    return { map, available };
  }

  async function get(): Promise<Leaderboard> {
    const current = now();
    if (cache && current.getTime() - cache.at < CACHE_MS) return cache.value;

    const [users, reports, solved] = await Promise.all([
      User.find({}, { name: 1, tracker: 1 }).lean(),
      HuntReport.find({}, { reportedBy: 1, site: 1 }).lean(),
      HintCell.find({ status: HintCellStatus.Solved, claimedBy: { $exists: true } }, { claimedBy: 1 }).lean(),
    ]);
    const window = distanceWindow(current, deps.huntStart, deps.huntEnd);
    const deviceIds = users.map((user) => user.tracker?.deviceId).filter((id): id is number => typeof id === "number");
    const { map, available } = await summaries(deviceIds, window.from, window.to);

    const value = buildLeaderboard({
      users: users.map((user) => ({ id: user._id.toString(), name: user.name, deviceId: user.tracker?.deviceId })),
      reports: reports.map((report) => ({ reportedBy: report.reportedBy.toString(), sitePoints: report.site ? report.site.points : null })),
      solvedBy: solved.map((cell) => cell.claimedBy!.toString()),
      summaries: map,
      distanceAvailable: available,
      window,
      now: current,
    });
    cache = { at: current.getTime(), value };
    return value;
  }

  return { get };
}
