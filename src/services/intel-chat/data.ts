import { knownAreaName } from "../../constants/areas";
import { isDemoMode } from "../../demo/demo-mode";
import { simulatedPositions } from "../../demo/simulated-trackers";
import { Article, publicArticlesFilter } from "../../models/article.model";
import { HintCell, HintCellStatus } from "../../models/hint-cell.model";
import { Team } from "../../models/team.model";
import { getLife360Service } from "../life360.service";
import * as traccar from "../traccar.service";
import type { AreaGroup } from "./geo";

/** Every scouting group with its (lowercase) area, if known */
export async function loadGroups(): Promise<AreaGroup[]> {
  const teams = await Team.find({}, { _id: 0, name: 1, area: 1, location: 1 }).lean();
  return teams.map((team) => ({ name: team.name, area: knownAreaName(team.area), lng: team.location.coordinates[0], lat: team.location.coordinates[1] }));
}

export interface SolvedHintPoint {
  articleId: number;
  articleTitle: string;
  area: string;
  slotTime: Date;
  lat: number;
  lng: number;
}

/** Solved hint cells with a coordinate answer (public hint articles only), newest slot first */
export async function loadSolvedHintPoints(): Promise<SolvedHintPoint[]> {
  const cells = await HintCell.find(
    { status: HintCellStatus.Solved, answerKind: "rd", "answerLocation.1": { $exists: true }, articleId: publicArticlesFilter().id },
    { _id: 0, articleId: 1, area: 1, slotTime: 1, answerLocation: 1 },
  )
    .sort({ slotTime: -1 })
    .lean();
  const titles = new Map((await Article.find({ id: { $in: [...new Set(cells.map((cell) => cell.articleId))] } }, { _id: 0, id: 1, title: 1 }).lean()).map((article) => [article.id, article.title]));
  return cells.map((cell) => ({
    articleId: cell.articleId,
    articleTitle: titles.get(cell.articleId) ?? `Hint ${cell.articleId}`,
    area: cell.area,
    slotTime: cell.slotTime,
    lng: cell.answerLocation![0],
    lat: cell.answerLocation![1],
  }));
}

export interface TrackerFix {
  name: string;
  source: "traccar" | "life360";
  lat: number;
  lng: number;
  at: Date;
}

interface PositionLike {
  latitude: number;
  longitude: number;
  deviceName?: string;
  fixTime?: string | Date;
  deviceTime?: string | Date;
  serverTime?: string | Date;
}

/** Traccar positions (demo: the simulated hunters); none when Traccar is not configured or fails */
async function traccarFixes(now: Date): Promise<TrackerFix[]> {
  let positions: PositionLike[] = [];
  if (isDemoMode()) positions = simulatedPositions(now);
  else if (traccar.isTraccarConfigured) positions = ((await traccar.getPositions().catch(() => [])) as unknown as PositionLike[]) ?? [];
  return positions
    .filter((position) => Number.isFinite(position.latitude) && Number.isFinite(position.longitude))
    .map((position) => ({
      name: position.deviceName ?? "Tracker",
      source: "traccar" as const,
      lat: position.latitude,
      lng: position.longitude,
      at: new Date(position.fixTime ?? position.deviceTime ?? position.serverTime ?? now),
    }));
}

/** Life360 members with a fix (memory only, no request to Life360) */
function life360Fixes(): TrackerFix[] {
  const members = getLife360Service()?.members().members ?? [];
  return members.flatMap((member) =>
    member.location ? [{ name: member.name, source: "life360" as const, lat: member.location.lat, lng: member.location.lon, at: new Date(member.location.at) }] : [],
  );
}

/** Where our own hunters are: Traccar devices and Life360 members */
export async function loadTrackers(now: Date): Promise<TrackerFix[]> {
  return [...(await traccarFixes(now)), ...life360Fixes()];
}
