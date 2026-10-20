import { createHash } from "node:crypto";
import distance from "@turf/distance";
import { currentGeneration } from "../../editions/work-tracking";
import { AreaStatusEvent } from "../../models/area-status-event.model";
import { Marker } from "../../models/marker.model";
import { RouteLeg } from "../../models/route-leg.model";
import { logger } from "../../logger";
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
const UNROUTABLE_RETRY_MS = 10 * 60_000;
const CACHE_DAYS = 30;
const MAX_STRAIGHT_KM = 60;
const CONCURRENCY = 4;
/** Resolved routes kept in memory so Mongo is only asked for misses. */
const RESOLVED_CAP = 5_000;

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

/** Small LRU of resolved routes by route key. */
function createRouteLru(cap: number) {
  const map = new Map<string, CachedRoute>();
  return {
    get(key: string) {
      const hit = map.get(key);
      if (hit) { map.delete(key); map.set(key, hit); }
      return hit;
    },
    set(key: string, route: CachedRoute) {
      map.delete(key);
      map.set(key, route);
      if (map.size > cap) map.delete(map.keys().next().value!);
    },
  };
}

interface Memo { at: number; stamp: string; value: TrailsResponse; body: string }

export function createTrailsService(deps: {
  router: Router;
  now?: () => Date;
  maxNewRoutesPerCall?: number;
  /** False when no router is configured (no ROUTER_URL): trails are then off and the client keeps its straight lines. */
  configured?: () => boolean;
  /** Database generation (changes on an edition switch). */
  dbGeneration?: () => number;
}) {
  const now = deps.now ?? (() => new Date());
  const maxNew = deps.maxNewRoutesPerCall ?? 12;
  const configured = deps.configured ?? (() => true);
  const dbGeneration = deps.dbGeneration ?? currentGeneration;
  let memo: Memo | null = null;
  let inflight: { stamp: string; promise: Promise<Memo> } | null = null;
  let generation = 0;
  /** Changes on invalidate and on an edition switch: a memo or computation of another stamp is never served. */
  const stamp = () => `${generation}:${dbGeneration()}`;
  const resolved = createRouteLru(RESOLVED_CAP);
  let cooldownUntil = 0;
  /** Legs the router said have no route: key -> time after which we try again. */
  const unroutable = new Map<string, number>();

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
    const nowMs = now().getTime();
    for (const [key, retryAfter] of unroutable) if (retryAfter <= nowMs) unroutable.delete(key);
    // Skip known-unroutable legs before slicing the budget so they cannot starve the rest
    const queue = uniqueJobs(jobs).filter((job) => !cache.has(job.key) && !unroutable.has(job.key) && !tooFar(job.from, job.to)).slice(0, Math.max(0, run.budget));
    run.budget -= queue.length;
    const worker = async () => {
      while (!run.stopped && queue.length) {
        const job = queue.shift()!;
        let route: CachedRoute;
        try {
          route = await routeOne(job, run.nightAreas);
        } catch (error) {
          if (error instanceof RoutingUnavailableError && error.kind === "request") {
            unroutable.set(job.key, now().getTime() + UNROUTABLE_RETRY_MS); // no route: stays straight
            continue;
          }
          if (!run.stopped) {
            const message = error instanceof Error ? error.message : String(error);
            if (error instanceof RoutingUnavailableError) logger.warn(`Router unavailable, pausing routing for ${COOLDOWN_MS / 1000}s: ${message}`);
            else logger.error(`Unexpected router error, pausing routing for ${COOLDOWN_MS / 1000}s: ${message}`);
          }
          run.stopped = true;
          cooldownUntil = now().getTime() + COOLDOWN_MS;
          continue;
        }
        cache.set(job.key, route);
        resolved.set(job.key, route);
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
    if (!setting.enabled || !configured()) return { enabled: false, trails: emptyCollection() };
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
    const cache = new Map<string, CachedRoute>();
    const loadCached = async (keys: string[]) => {
      const wanted: string[] = [];
      for (const key of new Set(keys)) {
        if (cache.has(key)) continue;
        const hit = resolved.get(key);
        if (hit) cache.set(key, hit);
        else wanted.push(key);
      }
      if (!wanted.length) return;
      for (const doc of await RouteLeg.find({ key: { $in: wanted } }).lean()) {
        const route = { coordinates: doc.coordinates as unknown as Coord[], distanceM: doc.distanceM, durationS: doc.durationS, nightFallback: doc.nightFallback ?? false };
        cache.set(doc.key, route);
        resolved.set(doc.key, route);
      }
    };
    await loadCached(walkJobs.map((j) => j.key));
    await routeJobs(walkJobs, cache, run);

    const carNeeded: Job[] = [];
    const classifiedByArea = areaLegs.map(({ area, legs }) => {
      const withWalk = legs.map((leg) => ({ ...leg, walkDurationS: cache.get(walkJob(leg).key)?.durationS ?? null }));
      const areaEvents = events.filter((e) => e.area.toLowerCase() === area.toLowerCase()).map((e) => ({ status: e.status, at: e.at }));
      const classified = classifyLegs(withWalk, areaEvents, now());
      for (const leg of classified) if (leg.mode !== "walk") carNeeded.push(carJob(leg));
      return { area, classified };
    });
    await loadCached(carNeeded.map((j) => j.key));
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

  /** The trails and their JSON, serialised once per memo (every poll within MEMO_MS gets the same string). */
  async function current(): Promise<Memo> {
    const started = stamp();
    if (memo && memo.stamp === started && now().getTime() - memo.at < MEMO_MS) return memo;
    // Concurrent callers share one computation; a result is only memoized if nothing invalidated it meanwhile
    if (inflight && inflight.stamp === started) return inflight.promise;
    const promise = compute()
      .then((value): Memo => ({ at: now().getTime(), stamp: started, value, body: JSON.stringify(value) }))
      .finally(() => { if (inflight?.promise === promise) inflight = null; });
    inflight = { stamp: started, promise };
    const result = await promise;
    if (stamp() === started) memo = result;
    return result;
  }

  return {
    async trails(): Promise<TrailsResponse> {
      return (await current()).value;
    },
    async trailsJson(): Promise<string> {
      return (await current()).body;
    },
    invalidate,
    routerCooldownUntil: () => cooldownUntil,
  };
}
