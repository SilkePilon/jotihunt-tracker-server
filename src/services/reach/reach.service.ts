import { logger } from "../../logger";
import { Area } from "../../models/area.model";
import { AreaStatusEvent } from "../../models/area-status-event.model";
import { Marker, MarkerType } from "../../models/marker.model";
import { Team } from "../../models/team.model";
import { RoutingUnavailableError } from "../prediction/routing";
import { listCurrentVisits, type VisitDto } from "../prediction/visit.service";
import type { IsochroneRouter, ReachProfile } from "../routes/graphhopper.client";
import { isNightAt } from "../routes/sun";
import type { TrailsResponse } from "../routes/trails.service";
import { coneIn, nearestUnvisited, reachCircle, simplifyArea, type AreaGeometry, type Group } from "./shape";
import { combineTrails, measureSpeed, type SpeedLeg, type TrailInfo } from "./speed";

export interface AreaReach {
  area: string;
  fix: { id: string; type: "hint" | "hunt"; at: string; lng: number; lat: number };
  speedKmh: number; measured: boolean; legs: number;
  distanceM: number; capped: boolean; night: boolean; estimate: boolean;
  polygon: AreaGeometry;
  cone: { teamApiId: number; name: string; bearing: number; distanceM: number; polygon: AreaGeometry } | null;
}
export interface ReachResponse { enabled: true; areas: AreaReach[] }

/** Walking time after which the area stops growing */
export const MAX_WALK_MS = 3 * 3600_000;
/** Distances are rounded to this, so a growing area asks the router about once a minute */
const ROUND_M = 100;
const MEMO_MS = 30_000;
const COOLDOWN_MS = 60_000;
const ISO_CACHE_CAP = 300;

type Coord = [number, number];

export function createReachService(deps: {
  router: IsochroneRouter;
  trails: () => Promise<TrailsResponse>;
  visits?: () => Promise<VisitDto[]>;
  now?: () => Date;
  /** False without ROUTER_URL: circles only */
  configured?: () => boolean;
}) {
  const now = deps.now ?? (() => new Date());
  const configured = deps.configured ?? (() => true);
  const visits = deps.visits ?? listCurrentVisits;
  const isoCache = new Map<string, AreaGeometry>();
  let cooldownUntil = 0;
  let memo: { at: number; value: ReachResponse; body: string } | null = null;
  let inflight: Promise<{ at: number; value: ReachResponse; body: string }> | null = null;

  async function areaShape(fixId: string, profile: ReachProfile, point: Coord, distanceM: number): Promise<{ polygon: AreaGeometry; estimate: boolean }> {
    const key = `${fixId}|${profile}|${distanceM}`;
    const hit = isoCache.get(key);
    if (hit) return { polygon: hit, estimate: false };
    if (configured() && now().getTime() >= cooldownUntil) {
      try {
        const polygon = simplifyArea(await deps.router.isochrone({ profile, point, distanceM }));
        isoCache.set(key, polygon);
        if (isoCache.size > ISO_CACHE_CAP) isoCache.delete(isoCache.keys().next().value!);
        return { polygon, estimate: false };
      } catch (error) {
        if (!(error instanceof RoutingUnavailableError)) logger.error(`Reach isochrone failed: ${error instanceof Error ? error.message : String(error)}`);
        else if (error.kind !== "request") {
          logger.warn(`Router unavailable for reach, circles for ${COOLDOWN_MS / 1000}s: ${error.message}`);
          cooldownUntil = now().getTime() + COOLDOWN_MS;
        }
      }
    }
    return { polygon: reachCircle(point, distanceM), estimate: true };
  }

  async function trailInfo(): Promise<Map<string, TrailInfo> | null> {
    try {
      const { enabled, trails } = await deps.trails();
      if (!enabled) return null;
      return new Map(trails.features.map((f) => [f.properties.id, { mode: f.properties.mode, distanceM: f.properties.distanceM }]));
    } catch (error) {
      logger.warn(`Reach without trails: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async function compute(): Promise<ReachResponse> {
    const at = now();
    const [areas, markers, events, teams, visitList, trails] = await Promise.all([
      Area.find({}, { name: 1, status: 1 }).lean(),
      // All types: trails chain spots too, a hint-to-hint leg can span several trail pieces
      Marker.find().sort({ time: 1 }).lean(),
      AreaStatusEvent.find().sort({ at: 1 }).lean(),
      Team.find({}, { apiId: 1, name: 1, area: 1, location: 1 }).lean(),
      visits(),
      trailInfo(),
    ]);
    const ov = new Set(areas.filter((a) => a.status === "blue").map((a) => a.name.toLowerCase()));
    const byArea = new Map<string, typeof markers>();
    for (const marker of markers) {
      const key = marker.area.toLowerCase();
      byArea.set(key, [...(byArea.get(key) ?? []), marker]);
    }

    const result: AreaReach[] = [];
    for (const [area, chain] of [...byArea.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (ov.has(area)) continue;
      // Spots are not fox positions: legs and the fix use hints/hunts only, the chain gives the trail pieces between them
      const fixIndexes = chain.flatMap((m, i) => (m.type === MarkerType.Hint || m.type === MarkerType.Hunt ? [i] : []));
      if (fixIndexes.length === 0) continue;
      const list = fixIndexes.map((i) => chain[i]);
      const fix = list[list.length - 1];
      const fixCoord = fix.location.coordinates as Coord;
      const legs: SpeedLeg[] = list.slice(1).map((to, i) => ({
        id: `${String(list[i]._id)}:${String(to._id)}`, from: list[i].time, to: to.time,
        fromCoord: list[i].location.coordinates as Coord, toCoord: to.location.coordinates as Coord,
      }));
      let legTrails: Map<string, TrailInfo> | null = null;
      if (trails) {
        legTrails = new Map();
        for (let k = 1; k < fixIndexes.length; k++) {
          const pieceIds: string[] = [];
          for (let i = fixIndexes[k - 1]; i < fixIndexes[k]; i++) pieceIds.push(`${String(chain[i]._id)}:${String(chain[i + 1]._id)}`);
          const info = combineTrails(pieceIds, trails);
          if (info) legTrails.set(legs[k - 1].id, info);
        }
      }
      const areaEvents = events.filter((e) => e.area.toLowerCase() === area).map((e) => ({ status: e.status, at: e.at }));
      const speed = measureSpeed(legs, legTrails, areaEvents, at);

      const sinceMs = Math.max(0, at.getTime() - fix.time.getTime());
      const capped = sinceMs > MAX_WALK_MS;
      const walkedM = (speed.kmh * 1000 * Math.min(sinceMs, MAX_WALK_MS)) / 3600_000;
      const distanceM = Math.max(ROUND_M, Math.round(walkedM / ROUND_M) * ROUND_M);
      const night = isNightAt(at, fixCoord[1], fixCoord[0]);
      const { polygon, estimate } = await areaShape(String(fix._id), night ? "foot_night" : "foot", fixCoord, distanceM);

      const groups: Group[] = teams
        .filter((team) => team.area?.toLowerCase() === area)
        .map((team) => ({ teamApiId: team.apiId, name: team.name, coord: team.location.coordinates as Coord }));
      const visited = new Set(visitList.filter((v) => v.area.toLowerCase() === area && v.state === "visited").map((v) => v.teamApiId));
      const target = nearestUnvisited(fixCoord, groups, visited);
      const conePolygon = target ? coneIn(fixCoord, target, polygon, distanceM + 50) : null;

      result.push({
        area,
        fix: { id: String(fix._id), type: fix.type as "hint" | "hunt", at: fix.time.toISOString(), lng: fixCoord[0], lat: fixCoord[1] },
        speedKmh: speed.kmh, measured: speed.measured, legs: speed.legs,
        distanceM, capped, night, estimate, polygon,
        cone: target && conePolygon ? { ...target, polygon: conePolygon } : null,
      });
    }
    return { enabled: true, areas: result };
  }

  async function current() {
    if (memo && now().getTime() - memo.at < MEMO_MS) return memo;
    if (inflight) return inflight;
    inflight = compute()
      .then((value) => (memo = { at: now().getTime(), value, body: JSON.stringify(value) }))
      .finally(() => { inflight = null; });
    return inflight;
  }

  return {
    async reach(): Promise<ReachResponse> { return (await current()).value; },
    async reachJson(): Promise<string> { return (await current()).body; },
  };
}
