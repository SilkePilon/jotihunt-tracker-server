import { readFile } from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import { Area } from "../../models/area.model";
import { HintCell, HintCellStatus } from "../../models/hint-cell.model";
import { Hunt } from "../../models/hunt.model";
import { HuntSyncEvent } from "../../models/hunt-sync-event.model";
import { Marker, MarkerType } from "../../models/marker.model";
import { Team } from "../../models/team.model";
import { User } from "../../models/user.model";
import { floorToHour, syncArticles } from "../../services/article-sync.service";
import { moveM } from "../../services/prediction/geo";
import type { LngLat } from "../../services/prediction/types";
import { syncHuntMarkers } from "../../services/hunt-sync.service";
import { formatRdAnswer, parseRdAnswer } from "../../services/rd-answer";
import type { ApiArticle } from "../../types/api";
import { setSimulation, LOOP_RADIUS_M, type SimulatedHunter } from "../simulated-trackers";
import { retimeArticles, demoHuntStart } from "./articles";
import { assignAreas, type GroupPoint } from "./assign-areas";
import { DEMO_AREAS, DEMO_DEVICE_ID_BASE, DEMO_HUNTERS, HOUR_MS, OSCAR, type DemoArea } from "./constants";
import { buildFoxRoute, OSCAR_FOX, positionAt, ringWaypoints, WALKING_FOX, type FoxRoute } from "./fox-routes";
import { planAreas, planHintCells, planSpots, planSyncedHunts, type CellPlan } from "./plans";
import { createRng, DEMO_SEED } from "./prng";

/** A team document as stored in the real database (read-only copy). */
export interface RealTeam {
  _id?: mongoose.Types.ObjectId;
  apiId: number;
  location: { type: "Point"; coordinates: number[] };
  [key: string]: unknown;
}

export interface WorldSources {
  /** Real teams (with logos) */
  teams(): Promise<RealTeam[]>;
}

export interface WorldOptions {
  sources: WorldSources;
  log?: (message: string) => void;
}

const ARTICLES_FILE = path.join(import.meta.dir, "..", "data", "articles-2025.json");
/** Somewhere in Gelderland, for a world without any teams */
const FALLBACK_CENTRE: LngLat = [5.9, 52.1];

function centroid(points: LngLat[]): LngLat {
  return [points.reduce((sum, p) => sum + p[0], 0) / points.length, points.reduce((sum, p) => sum + p[1], 0) / points.length];
}

/** Fox routes per area over the groups of that area (synthetic waypoints when an area has fewer than 3 groups). */
function buildRoutes(groupsByArea: Map<DemoArea, LngLat[]>, allCentre: LngLat, huntStart: Date, now: Date): Map<DemoArea, FoxRoute> {
  const routes = new Map<DemoArea, FoxRoute>();
  DEMO_AREAS.forEach((area, index) => {
    const rng = createRng(DEMO_SEED + 100 + index);
    let points = groupsByArea.get(area) ?? [];
    if (points.length < 3) {
      const angle = (index / DEMO_AREAS.length) * Math.PI * 2;
      const centre = points.length ? centroid(points) : area === OSCAR ? allCentre : moveM(allCentre, Math.cos(angle) * 15_000, Math.sin(angle) * 15_000);
      points = [...points, ...ringWaypoints(centre, 2500, 4 - points.length, rng)];
    }
    routes.set(area, buildFoxRoute(points, huntStart.getTime(), now.getTime() + 12 * HOUR_MS, rng, area === OSCAR ? OSCAR_FOX : WALKING_FOX));
  });
  return routes;
}

/** "21:43" in Dutch time, as the site shows a hunt time */
function localClock(date: Date): string {
  return date.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Amsterdam" });
}

/** Position within `radiusM` of `position` (a spot or hunt is never exactly on the fox). */
function jitter(position: LngLat, radiusM: number, rng: ReturnType<typeof createRng>): LngLat {
  const angle = rng.range(0, Math.PI * 2);
  const distance = rng.range(0, radiusM);
  return moveM(position, Math.cos(angle) * distance, Math.sin(angle) * distance);
}

async function createDemoUsers() {
  const docs = DEMO_HUNTERS.map((hunter, index) => ({
    name: hunter.name,
    admin: false,
    tracker: { deviceId: DEMO_DEVICE_ID_BASE + index, uniqueId: `demo-${hunter.name.toLowerCase()}`, vehicle: hunter.vehicle },
  }));
  // Only earlier demo hunters (by their demo tracker id): the copied real users may share a demo hunter's name
  await User.deleteMany({ "tracker.uniqueId": { $in: docs.map((doc) => doc.tracker.uniqueId) } });
  return User.insertMany(docs);
}

/** Apply the planned states to the hint cells; solved cells get the fox position as RD answer and a hint marker there. */
async function applyCellPlans(plans: CellPlan[], routes: Map<DemoArea, FoxRoute>) {
  const areaByLower = new Map(DEMO_AREAS.map((area) => [area.toLowerCase(), area]));
  const cellKey = (articleId: number, area: string) => `${articleId}|${area}`;
  const cells = await HintCell.find({}, { articleId: 1, area: 1, slotTime: 1, publishAt: 1 }).lean();
  const cellByKey = new Map(cells.map((cell) => [cellKey(cell.articleId, cell.area), cell]));

  const updates: { cellId: mongoose.Types.ObjectId; set: Record<string, unknown>; unset: Record<string, 1> }[] = [];
  /** Solved cells: the marker to create and the update that gets its id */
  const solved: { marker: Record<string, unknown>; set: Record<string, unknown> }[] = [];
  for (const plan of plans) {
    const cell = cellByKey.get(cellKey(plan.articleId, plan.area));
    if (!cell) continue;
    const set: Record<string, unknown> = { status: plan.status };
    const unset: Record<string, 1> = { claimedBy: 1, claimedAt: 1, check: 1, checkedBy: 1, notes: 1 };
    const area = areaByLower.get(plan.area);
    if (plan.status === HintCellStatus.Solved && area) {
      const answer = formatRdAnswer(...positionAt(routes.get(area)!, cell.slotTime.getTime()));
      const rd = parseRdAnswer(answer)!;
      const location = { type: "Point" as const, coordinates: [rd.lng, rd.lat] };
      solved.push({ marker: { area: plan.area, time: cell.slotTime, type: MarkerType.Hint, location }, set });
      // A believable solve time (8–37 min after publish), the same for a cell on every run
      const minutes = 8 + ((plan.articleId * 31 + plan.area.charCodeAt(0) * 7) % 30);
      Object.assign(set, { answer, answerKind: "rd", answerLocation: [rd.lng, rd.lat], markerId: null, solvedAt: new Date(cell.publishAt.getTime() + minutes * 60_000) });
    }
    updates.push({ cellId: cell._id, set, unset });
  }

  if (solved.length) {
    const markers = await Marker.insertMany(solved.map((item) => item.marker));
    markers.forEach((marker, index) => {
      solved[index].set.markerId = marker._id;
    });
  }
  if (updates.length) {
    await HintCell.bulkWrite(
      updates.map(({ cellId, set, unset }) => ({
        updateOne: { filter: { _id: cellId }, update: Object.keys(unset).length ? { $set: set, $unset: unset } : { $set: set } },
      })),
      // The legacy claim/check/notes fields are no longer in the schema; strict mode would drop their $unset
      { strict: false },
    );
  }
}

/**
 * Fill the (fresh) demo database: teams copied from the real database, areas, fox routes, the
 * real 2025 articles re-timed with their hint cells, markers, 8 demo hunters, hunts as synced from jotihunt.nl (with
 * their sync log and markers) and the simulated trackers. Deterministic for the same teams and `now`.
 */
export async function generateDemoWorld(now: Date, options: WorldOptions): Promise<void> {
  const log = options.log ?? (() => undefined);
  const huntStart = demoHuntStart(now);

  // Teams (with logos) assigned to areas geographically
  // Sorted: fox routes and everything placed on them follow the group order, so Mongo's return order must not matter
  const realTeams = (await options.sources.teams()).sort((a, b) => a.apiId - b.apiId);
  const groups: GroupPoint[] = realTeams.map((team) => ({ apiId: team.apiId, lng: team.location.coordinates[0], lat: team.location.coordinates[1] }));
  const areaOf = assignAreas(groups, createRng(DEMO_SEED + 1));
  if (realTeams.length) await Team.collection.insertMany(realTeams.map((team) => ({ ...team, area: areaOf.get(team.apiId) ?? null })));

  const areaPlans = planAreas(now, createRng(DEMO_SEED + 2));
  await Area.insertMany(areaPlans);
  const redAreas = areaPlans.filter((area) => area.status === "red").map((area) => area.name);
  const huntableAreas = areaPlans.filter((area) => area.status !== "red").map((area) => area.name);

  await createDemoUsers();

  // Fox routes
  const groupsByArea = new Map<DemoArea, LngLat[]>();
  for (const group of groups) {
    const area = areaOf.get(group.apiId);
    if (area) groupsByArea.set(area, [...(groupsByArea.get(area) ?? []), [group.lng, group.lat]]);
  }
  const allCentre = groups.length ? centroid(groups.map((group) => [group.lng, group.lat] as LngLat)) : FALLBACK_CENTRE;
  const routes = buildRoutes(groupsByArea, allCentre, huntStart, now);

  // Articles through the normal sync (creates the hint cells), then the cell states
  const { articles } = JSON.parse(await readFile(ARTICLES_FILE, "utf8")) as { articles: ApiArticle[] };
  const retimed = retimeArticles(articles, huntStart);
  const sync = await syncArticles(retimed);
  if (sync.failed.length) throw new Error(`Demo articles could not be stored: ${sync.failed.join(", ")}`);
  const hints = retimed.filter((article) => article.type === "hint").map((article) => ({ articleId: article.id, title: article.title, slotTime: floorToHour(new Date(article.publish_at)) }));
  const cells = await HintCell.find({}, { articleId: 1, area: 1, status: 1 }).lean();
  const cellPlans = planHintCells({ hints, cells, redAreas, now, rng: createRng(DEMO_SEED + 3) });
  await applyCellPlans(cellPlans, routes);

  // Spots
  const spotRng = createRng(DEMO_SEED + 4);
  for (const spot of planSpots(now, huntableAreas, spotRng)) {
    const position = jitter(positionAt(routes.get(spot.area)!, spot.time.getTime()), 50, spotRng);
    await Marker.create({ area: spot.area.toLowerCase(), time: spot.time, type: MarkerType.Spot, location: { type: "Point", coordinates: position } });
  }

  // Hunts as the jotihunt.nl sync stores them, with their sync log; markers come from the hunts
  const huntRng = createRng(DEMO_SEED + 5);
  const huntPlans = planSyncedHunts({ now, huntStart, areas: huntableAreas, rng: huntRng });
  for (const [index, plan] of huntPlans.entries()) {
    const [lng, lat] = jitter(positionAt(routes.get(plan.area)!, plan.huntTime.getTime()), 50, huntRng);
    const area = plan.area.toLowerCase();
    const qrCode = `DEMO-${String(index + 1).padStart(3, "0")}`;
    const location = { lat, lng, accuracy: plan.accuracy };
    const hunt = await Hunt.create({
      siteKey: `qr:${qrCode}`,
      area,
      status: plan.statusText,
      statusText: plan.statusText,
      statusClass: plan.status,
      points: plan.points,
      qrCode,
      huntTime: plan.huntTime,
      huntTimeText: localClock(plan.huntTime),
      location,
      firstSeenAt: plan.firstSeenAt,
      statusChangedAt: plan.judgedAt ?? null,
      updatedAt: now,
    });
    const event = { huntId: hunt._id, siteKey: `qr:${qrCode}`, area, huntTime: plan.huntTime, location };
    await HuntSyncEvent.create({ ...event, type: "new", points: null, at: plan.firstSeenAt });
    if (plan.judgedAt && plan.status !== "pending") await HuntSyncEvent.create({ ...event, type: plan.status, points: plan.status === "approved" ? plan.points : null, at: plan.judgedAt });
  }
  await syncHuntMarkers();

  // Simulated trackers: a loop around the centre of a huntable area per hunter; two stopped sending
  const trackerRng = createRng(DEMO_SEED + 6);
  const inactive = new Set(trackerRng.shuffle(DEMO_HUNTERS.map((_, index) => index)).slice(0, 2));
  const hunters: SimulatedHunter[] = DEMO_HUNTERS.map((hunter, index) => {
    const area = huntableAreas[index % huntableAreas.length];
    const areaGroups = groupsByArea.get(area);
    const centre = areaGroups?.length ? centroid(areaGroups) : positionAt(routes.get(area)!, now.getTime());
    return {
      deviceId: DEMO_DEVICE_ID_BASE + index,
      uniqueId: `demo-${hunter.name.toLowerCase()}`,
      name: hunter.name,
      vehicle: hunter.vehicle,
      centre,
      radiusM: LOOP_RADIUS_M[hunter.vehicle] * trackerRng.range(0.8, 1.2),
      phase: trackerRng.range(0, Math.PI * 2),
      direction: trackerRng.chance(0.5) ? 1 : -1,
      inactive: inactive.has(index),
      battery: trackerRng.int(70, 100),
    };
  });
  setSimulation({ huntStart, hunters });
  log(`Demo world: ${realTeams.length} teams, ${sync.upserted} articles, ${cellPlans.length} hint cells, ${huntPlans.length} hunts`);
}
