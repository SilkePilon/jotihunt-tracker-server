import { createHash } from "node:crypto";
import distance from "@turf/distance";
import { AreaStatusEvent } from "../../models/area-status-event.model";
import { Marker } from "../../models/marker.model";
import { RouteLeg } from "../../models/route-leg.model";
import { getRoutesSetting, nightAreasHash, onRoutesSettingChange } from "../../settings/night-areas-setting";
import { RoutingUnavailableError } from "../prediction/routing";
import type { NightArea, RouteResult, Router } from "./graphhopper.client";
import { classifyLegs, legNight, type LegInput, type LegReason } from "./trail-legs";

export interface TrailProperties {
  id: string; // `${fromId}:${toId}`
  area: string; fromId: string; toId: string;
  mode: "walk" | "car" | "extra"; reason: LegReason; manual: boolean; night: boolean; nightFallback: boolean;
  fallback: boolean; fromTime: string; toTime: string;
  distanceM: number | null; durationS: number | null; walkDurationS: number | null;
  redFrom?: string; redTo?: string;
}
export interface TrailsResponse { enabled: boolean; trails: GeoJSON.FeatureCollection<GeoJSON.LineString, TrailProperties> }

const MEMO_MS = 5_000;
const COOLDOWN_MS = 60_000;
const CACHE_DAYS = 30;
const MAX_STRAIGHT_KM = 60;
const CONCURRENCY = 4;

type Coord = [number, number];
interface CachedRoute extends RouteResult { nightFallback: boolean }
interface Job { key: string; profile: "foot" | "car"; from: Coord; to: Coord; night: boolean }

const fmt = (c: Coord) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
/** `areasHash` is taken once per computation so job creation and lookup always agree. */
const walkKey = (from: Coord, to: Coord, night: boolean, areasHash: string) => sha1(["foot", night ? `n${areasHash}` : "d", fmt(from), fmt(to)].join("|"));
const carKey = (from: Coord, to: Coord) => sha1(["car", fmt(from), fmt(to)].join("|"));
const tooFar = (from: Coord, to: Coord) => distance(from, to, { units: "kilometers" }) > MAX_STRAIGHT_KM;
const emptyCollection = (): TrailsResponse["trails"] => ({ type: "FeatureCollection", features: [] });

/** Unique jobs by key (identical legs share one route). */
function uniqueJobs(jobs: Job[]): Job[] {
  return [...new Map(jobs.map((job) => [job.key, job])).values()];
}

export function createTrailsService(deps: { router: Router; now?: () => Date; maxNewRoutesPerCall?: number }) {
  const now = deps.now ?? (() => new Date());
  const maxNew = deps.maxNewRoutesPerCall ?? 12;
  let memo: { at: number; value: TrailsResponse } | null = null;
  let inflight: { generation: number; promise: Promise<TrailsResponse> } | null = null;
  let generation = 0;
  let cooldownUntil = 0;

  const invalidate = () => { memo = null; generation++; };
  onRoutesSettingChange(invalidate);

  /** One computation: shared new-route budget for walk and car routes, and a stop flag once the router fails. */
  interface Run { budget: number; stopped: boolean; nightAreas: NightArea[] }

  async function routeOne(job: Job, nightAreas: NightArea[]): Promise<CachedRoute> {
    try {
      const result = await deps.router.route({ profile: job.profile, from: job.from, to: job.to, night: job.night, nightAreas });
      return { ...result, nightFallback: false };
    } catch (error) {
      if (!(error instanceof RoutingUnavailableError) || error.kind !== "request" || !job.night) throw error;
      // No night route (e.g. everything closed): walk it by day, cached under the night key and flagged
      const result = await deps.router.route({ profile: job.profile, from: job.from, to: job.to, night: false, nightAreas });
      return { ...result, nightFallback: true };
    }
  }

  async function routeJobs(jobs: Job[], cache: Map<string, CachedRoute>, run: Run) {
    if (now().getTime() < cooldownUntil) run.stopped = true;
    if (run.stopped) return;
    const queue = uniqueJobs(jobs).filter((job) => !cache.has(job.key) && !tooFar(job.from, job.to)).slice(0, Math.max(0, run.budget));
    run.budget -= queue.length;
    const worker = async () => {
      while (!run.stopped && queue.length) {
        const job = queue.shift()!;
        let route: CachedRoute;
        try {
          route = await routeOne(job, run.nightAreas);
        } catch (error) {
          if (error instanceof RoutingUnavailableError && error.kind === "request") continue; // no route: stays straight
          run.stopped = true;
          cooldownUntil = now().getTime() + COOLDOWN_MS;
          continue;
        }
        cache.set(job.key, route);
        try {
          await RouteLeg.updateOne(
            { key: job.key },
            { $set: { ...route, expiresAt: new Date(now().getTime() + CACHE_DAYS * 86_400_000) } },
            { upsert: true },
          );
        } catch (error) {
          console.warn("Could not cache route leg", error); // still used for this response
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  async function compute(): Promise<TrailsResponse> {
    const setting = getRoutesSetting();
    if (!setting.enabled) return { enabled: false, trails: emptyCollection() };
    const areasHash = nightAreasHash();
    const run: Run = { budget: maxNew, stopped: false, nightAreas: setting.areas };

    const markers = await Marker.find().sort({ time: 1 }).lean();
    const byArea = new Map<string, typeof markers>();
    for (const marker of markers) {
      const list = byArea.get(marker.area) ?? [];
      list.push(marker);
      byArea.set(marker.area, list);
    }
    const events = await AreaStatusEvent.find().sort({ at: 1 }).lean();

    const areaLegs = [...byArea.entries()].map(([area, list]) => ({
      area,
      legs: list.slice(1).map((to, i): LegInput & { night: boolean } => {
        const from = list[i];
        const leg = {
          fromId: String(from._id), toId: String(to._id), from: from.time, to: to.time,
          fromCoord: from.location.coordinates as Coord, toCoord: to.location.coordinates as Coord,
          override: (to.legMode as "walk" | "car" | null | undefined) ?? null, walkDurationS: null,
        };
        return { ...leg, night: legNight(leg) };
      }),
    }));
    const allLegs = areaLegs.flatMap(({ legs }) => legs);
    const walkJob = (leg: LegInput & { night: boolean }): Job => ({ key: walkKey(leg.fromCoord, leg.toCoord, leg.night, areasHash), profile: "foot", from: leg.fromCoord, to: leg.toCoord, night: leg.night });
    const carJob = (leg: LegInput): Job => ({ key: carKey(leg.fromCoord, leg.toCoord), profile: "car", from: leg.fromCoord, to: leg.toCoord, night: false });

    // Walking routes for every leg first (the speed check needs their duration)
    const walkJobs = allLegs.map(walkJob);
    const keys = [...new Set([...walkJobs, ...allLegs.map(carJob)].map((j) => j.key))];
    const cache = new Map<string, CachedRoute>(
      (await RouteLeg.find({ key: { $in: keys } }).lean()).map((doc) => [
        doc.key, { coordinates: doc.coordinates as unknown as Coord[], distanceM: doc.distanceM, durationS: doc.durationS, nightFallback: doc.nightFallback ?? false },
      ]),
    );
    await routeJobs(walkJobs, cache, run);

    const carNeeded: Job[] = [];
    const classifiedByArea = areaLegs.map(({ area, legs }) => {
      const withWalk = legs.map((leg) => ({ ...leg, walkDurationS: cache.get(walkJob(leg).key)?.durationS ?? null }));
      const areaEvents = events.filter((e) => e.area.toLowerCase() === area.toLowerCase()).map((e) => ({ status: e.status, at: e.at }));
      const classified = classifyLegs(withWalk, areaEvents, now());
      for (const leg of classified) if (leg.mode !== "walk") carNeeded.push(carJob(leg));
      return { area, classified };
    });
    await routeJobs(carNeeded, cache, run);

    const features: TrailsResponse["trails"]["features"] = [];
    for (const { area, classified } of classifiedByArea) {
      for (const leg of classified) {
        // leg.night is legNight() of the same leg, so this is the key the walk job used
        const route = cache.get(leg.mode === "walk" ? walkJob(leg).key : carJob(leg).key);
        features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: route?.coordinates ?? [leg.fromCoord, leg.toCoord] },
          properties: {
            id: `${leg.fromId}:${leg.toId}`, area, fromId: leg.fromId, toId: leg.toId,
            mode: leg.mode, reason: leg.reason, manual: leg.manual, night: leg.night,
            nightFallback: leg.mode === "walk" && (route?.nightFallback ?? false),
            fallback: !route, fromTime: leg.from.toISOString(), toTime: leg.to.toISOString(),
            distanceM: route?.distanceM ?? null, durationS: route?.durationS ?? null, walkDurationS: leg.walkDurationS,
            ...(leg.redFrom && leg.redTo ? { redFrom: leg.redFrom.toISOString(), redTo: leg.redTo.toISOString() } : {}),
          },
        });
      }
    }
    return { enabled: true, trails: { type: "FeatureCollection", features } };
  }

  return {
    async trails(): Promise<TrailsResponse> {
      if (memo && now().getTime() - memo.at < MEMO_MS) return memo.value;
      // Concurrent callers share one computation; a result is only memoized if nothing invalidated it meanwhile
      if (inflight && inflight.generation === generation) return inflight.promise;
      const started = generation;
      const promise = compute().finally(() => { if (inflight?.promise === promise) inflight = null; });
      inflight = { generation: started, promise };
      const value = await promise;
      if (generation === started) memo = { at: now().getTime(), value };
      return value;
    },
    invalidate,
    routerCooldownUntil: () => cooldownUntil,
  };
}
