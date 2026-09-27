import { Area } from "../../models/area.model";
import { Marker } from "../../models/marker.model";
import { Prediction } from "../../models/prediction.model";
import { PredictionModel } from "../../models/prediction-model.model";
import { Team } from "../../models/team.model";
import { createHash } from "node:crypto";
import {
  ORS_COOLDOWN_MS,
  ORS_REQUEST_FALLBACK_TTL_MS,
  RECOMPUTE_INTERVAL_MS,
  TOP_CANDIDATES,
  TRANSIT_CACHE_MS,
  TRANSIT_COOLDOWN_MS,
  VISIT_RADIUS_M,
} from "./constants";
import { distanceM } from "./geo";
import {
  dwellSample,
  evaluateSnapshot,
  speedSample,
  updateDwell,
  updateSpeedFactor,
  updateWeights,
  type Accuracy,
  type SnapshotCandidate,
} from "./learning";
import { RoutingUnavailableError, TransitUnavailableError, type RouteResult, type TransitItinerary, type TransitPlanner, type WalkingRouter } from "./routing";
import { readCache, readCacheEntry, writeCache } from "./routing-cache";
import { computeHeading, scoreCandidates } from "./scoring";
import { straightLineSeconds } from "./straight-line.router";
import { planTour } from "./tour";
import { alightingStops, chooseTravel, isTransitMode, selectIslands, type TravelChoice } from "./transit";
import { nearestStopDistanceM } from "./transit-stop.service";
import { DEFAULT_PARAMS, type GroupRef, type LngLat, type Observation, type ObservationKind, type PolygonGeometry, type Weights } from "./types";
import { loadManualVisits, manualVisitsVersion, replaceAutoVisits } from "./visit.service";
import { assignRounds, candidateIds, detectPointVisits, detectRouteVisits, type ManualVisit, type RoundState } from "./visits";
import { elapsedMinutes, ISOCHRONE_RANGES_MIN, pickRing, zoneRanges } from "./zones";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export interface PredictionDeps {
  walking: WalkingRouter;
  /** Used when `walking` throws RoutingUnavailableError */
  fallback: WalkingRouter;
  transit: TransitPlanner;
  now?: () => Date;
}

export interface CandidateDto {
  teamApiId: number;
  name: string;
  lng: number;
  lat: number;
  probability: number;
  travelMinutes: number;
  eta: Date;
  via: "walk" | "transit";
  transitLabel?: string;
  overdue: boolean;
}

export interface PredictionDto {
  area: string;
  status: string;
  mode: "walking" | "transit";
  estimate: boolean;
  transitUnavailable: boolean;
  lastObservation: { time: Date; lng: number; lat: number; kind: ObservationKind } | null;
  zone: { core: PolygonGeometry | null; outer: PolygonGeometry | null; islands: PolygonGeometry[] };
  candidates: CandidateDto[];
  accuracy: Accuracy;
  updatedAt: Date;
  paused: boolean;
  reason?: string;
  round: number;
}

interface PendingSnapshot {
  basedOn: Date;
  candidates: SnapshotCandidate[];
}

interface LearnedModel {
  speedFactor: number;
  dwellMinutes: number;
  weights: Weights;
  accuracy: Accuracy;
  lastHintTime: Date | null;
  lastDwellVisitAt: Date | null;
  pendingSnapshot: PendingSnapshot | null;
}

interface ObservationRecord extends Observation {
  id: string;
}

interface AreaContext {
  area: string;
  status: string;
  groups: GroupRef[];
  observations: ObservationRecord[];
}

interface RunFlags {
  estimate: boolean;
  transitUnavailable: boolean;
}

interface VisitedAt {
  teamApiId: number;
  visitedAt: Date;
}

interface PredictedPart {
  mode: "walking" | "transit";
  zone: PredictionDto["zone"];
  candidates: CandidateDto[];
  snapshot: SnapshotCandidate[];
}

/** Stable cache key for a coordinate (~1 m precision). */
export function coordKey([lng, lat]: LngLat): string {
  return `${lng.toFixed(5)},${lat.toFixed(5)}`;
}

/** Short cache key for a set of groups: ids and coordinates, so a moved group gets a new key. */
function groupsKey(groups: GroupRef[]): string {
  const parts = groups.map((group) => `${group.teamApiId}@${coordKey([group.lng, group.lat])}`).join(";");
  return createHash("sha1").update(parts).digest("hex");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function minutesBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 60_000;
}

/** Lowercase names of all known areas (from the Jotihunt areas and the groups' areas). */
export async function listAreaNames(): Promise<string[]> {
  const [areaNames, teamAreas] = await Promise.all([Area.distinct("name"), Team.distinct("area")]);
  const names = [...areaNames, ...teamAreas].filter((name): name is string => typeof name === "string" && name.trim().length > 0);
  return [...new Set(names.map((name) => name.toLowerCase()))].sort();
}

/** Stored predictions for the API (without the learning snapshot and the signature). */
export async function listPredictions() {
  return Prediction.find({}, { _id: 0, __v: 0, snapshot: 0, signature: 0 }).sort({ area: 1 }).lean();
}

async function loadContext(area: string): Promise<AreaContext> {
  const nameRegex = new RegExp(`^${escapeRegExp(area)}$`, "i");
  const [areaDoc, teams, markers] = await Promise.all([
    Area.findOne({ name: nameRegex }).lean(),
    Team.find({ area: nameRegex }).lean(),
    Marker.find({ area: nameRegex }).sort({ time: 1 }).lean(),
  ]);
  return {
    area,
    status: areaDoc?.status ?? "unknown",
    groups: teams
      .map((team) => ({ teamApiId: team.apiId, name: team.name, lng: team.location.coordinates[0], lat: team.location.coordinates[1] }))
      .sort((a, b) => a.teamApiId - b.teamApiId),
    observations: markers.map((marker) => ({
      id: String(marker._id),
      time: marker.time,
      lng: marker.location.coordinates[0],
      lat: marker.location.coordinates[1],
      kind: marker.type as ObservationKind,
    })),
  };
}

async function signatureFor(ctx: AreaContext): Promise<string> {
  const last = ctx.observations.at(-1);
  return [
    ctx.status,
    ctx.groups.map((group) => group.teamApiId).join(","),
    ctx.observations.length,
    last ? `${last.id}@${last.time.toISOString()}` : "-",
    await manualVisitsVersion(ctx.area),
  ].join("|");
}

async function loadModel(area: string): Promise<LearnedModel> {
  const doc = (await PredictionModel.findOne({ area }).lean()) ?? (await PredictionModel.create({ area })).toObject();
  const defaults = DEFAULT_PARAMS.weights;
  return {
    speedFactor: doc.speedFactor ?? DEFAULT_PARAMS.speedFactor,
    dwellMinutes: doc.dwellMinutes ?? DEFAULT_PARAMS.dwellMinutes,
    weights: {
      wTime: doc.weights?.wTime ?? defaults.wTime,
      wHeading: doc.weights?.wHeading ?? defaults.wHeading,
      wTour: doc.weights?.wTour ?? defaults.wTour,
      wCluster: doc.weights?.wCluster ?? defaults.wCluster,
    },
    accuracy: {
      top1Hits: doc.accuracy?.top1Hits ?? 0,
      top3Hits: doc.accuracy?.top3Hits ?? 0,
      evaluations: doc.accuracy?.evaluations ?? 0,
    },
    lastHintTime: doc.lastHintTime ?? null,
    lastDwellVisitAt: doc.lastDwellVisitAt ?? null,
    pendingSnapshot: (doc.pendingSnapshot as PendingSnapshot | null | undefined) ?? null,
  };
}

async function saveModel(area: string, model: LearnedModel): Promise<void> {
  await PredictionModel.updateOne({ area }, { $set: model });
}

function visitedList(state: RoundState, manual: ManualVisit[]): VisitedAt[] {
  return [
    ...state.autoVisits.map((visit) => ({ teamApiId: visit.teamApiId, visitedAt: visit.visitedAt })),
    ...manual
      .filter((visit) => visit.state === "visited" && visit.visitedAt)
      .map((visit) => ({ teamApiId: visit.teamApiId, visitedAt: visit.visitedAt as Date })),
  ].sort((a, b) => a.visitedAt.getTime() - b.visitedAt.getTime());
}

/**
 * Prediction service. Routing clients are injected so tests run without network.
 */
export function createPredictionService(deps: PredictionDeps) {
  const now = deps.now ?? (() => new Date());
  const locks = new Map<string, Promise<unknown>>();

  /**
   * ORS circuit breaker, shared across areas/ticks for the life of this service instance.
   * - `permanent`: no or rejected API key (401/403); never call ORS again, never churn a cooldown.
   * - `openUntil`: set after a temporary error (429/5xx/timeout/network); while `now() < openUntil`,
   *   skip ORS entirely (straight to the fallback). Once elapsed the next call is a half-open probe:
   *   success closes the breaker, failure re-opens it for another ORS_COOLDOWN_MS.
   * Request-specific errors (400/404) never touch the breaker (see `routed`).
   */
  const orsBreaker: { permanent: boolean; openUntil: number | null } = { permanent: false, openUntil: null };
  /** Transitous cooldown after a TransitUnavailableError (walking only until then). */
  const transitBreaker: { openUntil: number | null } = { openUntil: null };

  /** Run tasks for the same area one at a time (cron and PUT /visits can overlap). */
  function withLock<T>(area: string, task: () => Promise<T>): Promise<T> {
    const previous = locks.get(area) ?? Promise.resolve();
    const run = previous.then(task);
    locks.set(
      area,
      run.catch(() => undefined),
    );
    return run;
  }

  /**
   * Cached walking-router call; on RoutingUnavailableError use the fallback router.
   * A request-specific failure (e.g. an unroutable point) leaves ORS open for everything else and
   * caches the fallback under this key for 6 h, so the bad request is not re-probed every tick.
   */
  async function routed<T>(flags: RunFlags, key: string, ttlMs: number, request: (router: WalkingRouter) => Promise<T>): Promise<T> {
    const hit = await readCacheEntry<T>(key);
    if (hit !== undefined) {
      if (hit.estimate) flags.estimate = true;
      return hit.value;
    }
    if (orsBreaker.permanent || (orsBreaker.openUntil !== null && now().getTime() < orsBreaker.openUntil)) {
      flags.estimate = true;
      return request(deps.fallback);
    }
    try {
      const value = await request(deps.walking);
      await writeCache(key, value, ttlMs);
      orsBreaker.openUntil = null;
      return value;
    } catch (error) {
      if (!(error instanceof RoutingUnavailableError)) throw error;
      flags.estimate = true;
      if (error.kind === "request") {
        const value = await request(deps.fallback);
        await writeCache(key, value, Math.min(ttlMs, ORS_REQUEST_FALLBACK_TTL_MS), { estimate: true });
        return value;
      }
      if (error.kind === "permanent") {
        orsBreaker.permanent = true;
      } else {
        orsBreaker.openUntil = now().getTime() + ORS_COOLDOWN_MS;
      }
      return request(deps.fallback);
    }
  }

  function routeBetween(flags: RunFlags, a: Observation, b: Observation): Promise<RouteResult> {
    const from: LngLat = [a.lng, a.lat];
    const to: LngLat = [b.lng, b.lat];
    if (distanceM(from, to) < 10) return Promise.resolve({ line: [from, to], distanceM: 0, durationS: 0 });
    return routed(flags, `route:${coordKey(from)}>${coordKey(to)}`, WEEK_MS, (router) => router.route(from, to));
  }

  function isochronesAt(flags: RunFlags, center: LngLat) {
    return routed(flags, `iso:${coordKey(center)}`, DAY_MS, (router) => router.isochrones(center, ISOCHRONE_RANGES_MIN));
  }

  async function planTransit(flags: RunFlags, area: string, last: Observation, group: GroupRef, from: LngLat, departAt: Date): Promise<TransitItinerary | null> {
    const to: LngLat = [group.lng, group.lat];
    const key = `transit:${area}:${last.time.toISOString()}:${coordKey(from)}:${group.teamApiId}@${coordKey(to)}`;
    const hit = await readCache<{ itinerary: TransitItinerary | null }>(key);
    if (hit) return hit.itinerary;
    if (transitBreaker.openUntil !== null && now().getTime() < transitBreaker.openUntil) {
      flags.transitUnavailable = true;
      return null;
    }
    try {
      const itinerary = await deps.transit.plan(from, to, departAt);
      await writeCache(key, { itinerary }, TRANSIT_CACHE_MS);
      transitBreaker.openUntil = null;
      return itinerary;
    } catch (error) {
      if (!(error instanceof TransitUnavailableError)) throw error;
      flags.transitUnavailable = true;
      transitBreaker.openUntil = now().getTime() + TRANSIT_COOLDOWN_MS;
      return null;
    }
  }

  /** Recompute all visits of the area from its observations and store the auto visits. */
  async function syncVisits(flags: RunFlags, ctx: AreaContext): Promise<{ state: RoundState; manual: ManualVisit[] }> {
    const manual = await loadManualVisits(ctx.area);
    const events = detectPointVisits(ctx.observations, ctx.groups);
    if (ctx.groups.length > 0) {
      for (let i = 1; i < ctx.observations.length; i++) {
        const from = ctx.observations[i - 1];
        const to = ctx.observations[i];
        const route = await routeBetween(flags, from, to);
        events.push(...detectRouteVisits(from, to, route.line, ctx.groups));
      }
    }
    const state = assignRounds(
      ctx.groups.map((group) => group.teamApiId),
      events,
      manual,
    );
    await replaceAutoVisits(ctx.area, state.autoVisits);
    return { state, manual };
  }

  /** Live learning: speed, pending snapshot + evaluation, dwell. Mutates `model`. */
  async function learn(flags: RunFlags, ctx: AreaContext, visits: VisitedAt[], previous: { snapshot?: unknown; lastObservation?: unknown } | null, model: LearnedModel) {
    const hints = ctx.observations.filter((observation) => observation.kind === "hint");
    const newest = hints.at(-1);
    if (newest && (!model.lastHintTime || newest.time.getTime() > model.lastHintTime.getTime())) {
      const before = hints.at(-2);
      if (before) {
        const route = await routeBetween(flags, before, newest);
        const sample = speedSample(route.distanceM, minutesBetween(before.time, newest.time), model.dwellMinutes);
        if (sample !== null) model.speedFactor = updateSpeedFactor(model.speedFactor, sample);
      }
      const snapshot = previous?.snapshot as SnapshotCandidate[] | undefined;
      const basedOn = (previous?.lastObservation as { time?: Date } | null | undefined)?.time;
      if (!model.pendingSnapshot && snapshot && snapshot.length > 0 && basedOn) {
        model.pendingSnapshot = { basedOn: new Date(basedOn), candidates: snapshot };
      }
      model.lastHintTime = newest.time;
    }

    const pending = model.pendingSnapshot;
    if (pending) {
      const actual = visits.find((visit) => visit.visitedAt.getTime() > new Date(pending.basedOn).getTime());
      if (actual) {
        model.accuracy = evaluateSnapshot(model.accuracy, pending.candidates, actual.teamApiId);
        model.weights = updateWeights(model.weights, pending.candidates, actual.teamApiId);
        model.pendingSnapshot = null;
      }
    }

    const dwellFrom = model.lastDwellVisitAt?.getTime() ?? 0;
    for (const visit of visits.filter((candidate) => candidate.visitedAt.getTime() > dwellFrom)) {
      const group = ctx.groups.find((candidate) => candidate.teamApiId === visit.teamApiId);
      if (!group) continue;
      const groupLocation: LngLat = [group.lng, group.lat];
      const leave = ctx.observations.find(
        (observation) => observation.time.getTime() > visit.visitedAt.getTime() && distanceM([observation.lng, observation.lat], groupLocation) > VISIT_RADIUS_M,
      );
      if (!leave) break;
      const travelMinutes = straightLineSeconds(groupLocation, [leave.lng, leave.lat]) / 60 / model.speedFactor;
      const sample = dwellSample(visit.visitedAt, leave.time, travelMinutes);
      if (sample !== null) model.dwellMinutes = updateDwell(model.dwellMinutes, sample);
      model.lastDwellVisitAt = visit.visitedAt;
    }
  }

  async function predict(flags: RunFlags, ctx: AreaContext, last: ObservationRecord, state: RoundState, model: LearnedModel, at: Date): Promise<PredictedPart> {
    const position: LngLat = [last.lng, last.lat];
    const coords = ctx.groups.map((group): LngLat => [group.lng, group.lat]);
    const groupsHash = groupsKey(ctx.groups);
    const fromPosition = await routed(flags, `pmatrix:${coordKey(position)}:${groupsHash}`, DAY_MS, (router) => router.matrix([position], coords));
    const between = await routed(flags, `gmatrix:${ctx.area}:${groupsHash}`, WEEK_MS, (router) => router.matrix(coords, coords));

    const open = new Set(
      candidateIds(
        ctx.groups.map((group) => group.teamApiId),
        state,
        at,
      ),
    );
    const transitMode = isTransitMode({ area: ctx.area, status: ctx.status, nearestStopDistanceM: await nearestStopDistanceM(position) });
    const departAt = new Date(last.time.getTime() + model.dwellMinutes * 60_000);
    const itineraries: TransitItinerary[] = [];
    const entries: { group: GroupRef; index: number; walkSeconds: number; choice: TravelChoice }[] = [];

    for (const [index, group] of ctx.groups.entries()) {
      if (!open.has(group.teamApiId)) continue;
      const walkSeconds = fromPosition.durationsS[0]?.[index] ?? straightLineSeconds(position, coords[index]);
      let itinerary: TransitItinerary | null = null;
      if (transitMode && !flags.transitUnavailable) {
        itinerary = await planTransit(flags, ctx.area, last, group, position, departAt);
        if (itinerary) itineraries.push(itinerary);
      }
      entries.push({ group, index, walkSeconds, choice: chooseTravel(walkSeconds / 60 / model.speedFactor, itinerary, departAt) });
    }

    const matrix = entries.map((a) =>
      entries.map((b) => (a === b ? 0 : (between.durationsS[a.index]?.[b.index] ?? straightLineSeconds(coords[a.index], coords[b.index])))),
    );
    const tour = planTour(
      entries.map((entry) => entry.walkSeconds),
      matrix,
    );
    const scored = scoreCandidates({
      position,
      heading: computeHeading(ctx.observations),
      tourFirstIndex: tour.length > 0 ? tour[0] : null,
      weights: model.weights,
      candidates: entries.map((entry) => ({ teamApiId: entry.group.teamApiId, location: coords[entry.index], travelMinutes: entry.choice.travelMinutes })),
    });
    const ranked = scored.map((score, index) => ({ ...score, entry: entries[index] })).sort((a, b) => b.probability - a.probability);

    const candidates = ranked.slice(0, TOP_CANDIDATES).map(({ probability, entry }) => {
      const eta = new Date(last.time.getTime() + (model.dwellMinutes + entry.choice.travelMinutes) * 60_000);
      const candidate: CandidateDto = {
        teamApiId: entry.group.teamApiId,
        name: entry.group.name,
        lng: entry.group.lng,
        lat: entry.group.lat,
        probability,
        travelMinutes: Math.round(entry.choice.travelMinutes),
        eta,
        via: entry.choice.via,
        overdue: eta.getTime() < at.getTime(),
      };
      if (entry.choice.transitLabel) candidate.transitLabel = entry.choice.transitLabel;
      return candidate;
    });
    const snapshot = ranked.map(({ teamApiId, probability, terms }) => ({ teamApiId, probability, terms }));

    const { outerMin, coreMin } = zoneRanges(elapsedMinutes(at, last.time, model.dwellMinutes), model.speedFactor);
    const rings = await isochronesAt(flags, position);
    const zone: PredictionDto["zone"] = { core: pickRing(rings, position, coreMin), outer: pickRing(rings, position, outerMin), islands: [] };
    if (transitMode) {
      for (const { stop, remainingMinutes } of selectIslands(alightingStops(itineraries), at)) {
        const center: LngLat = [stop.lng, stop.lat];
        zone.islands.push(pickRing(await isochronesAt(flags, center), center, zoneRanges(remainingMinutes, model.speedFactor).outerMin));
      }
    }

    return { mode: transitMode ? "transit" : "walking", zone, candidates, snapshot };
  }

  async function compute(ctx: AreaContext, signature: string): Promise<PredictionDto> {
    const at = now();
    const flags: RunFlags = { estimate: false, transitUnavailable: false };
    const previous = await Prediction.findOne({ area: ctx.area }).lean();
    const model = await loadModel(ctx.area);
    const { state, manual } = await syncVisits(flags, ctx);
    if (ctx.groups.length > 0) await learn(flags, ctx, visitedList(state, manual), previous, model);
    await saveModel(ctx.area, model);

    const last = ctx.observations.at(-1);
    const dto: PredictionDto = {
      area: ctx.area,
      status: ctx.status,
      mode: "walking",
      estimate: false,
      transitUnavailable: false,
      lastObservation: last ? { time: last.time, lng: last.lng, lat: last.lat, kind: last.kind } : null,
      zone: { core: null, outer: null, islands: [] },
      candidates: [],
      accuracy: model.accuracy,
      updatedAt: at,
      paused: false,
      round: state.currentRound,
    };
    let snapshot: SnapshotCandidate[] = [];

    if (ctx.groups.length === 0) {
      dto.reason = "Geen groepen gekoppeld";
    } else if (ctx.status === "red") {
      dto.paused = true;
      dto.reason = "Inactief, voorspelling gepauzeerd";
    } else if (!last) {
      dto.reason = "Nog geen waarnemingen";
    } else {
      const part = await predict(flags, ctx, last, state, model, at);
      dto.mode = part.mode;
      dto.zone = part.zone;
      dto.candidates = part.candidates;
      snapshot = part.snapshot;
    }

    dto.estimate = flags.estimate;
    dto.transitUnavailable = flags.transitUnavailable;
    await Prediction.replaceOne({ area: ctx.area }, { ...dto, snapshot, signature }, { upsert: true });
    return dto;
  }

  /** Recompute one area now (e.g. after a manual visit change). */
  function recomputeArea(area: string): Promise<PredictionDto> {
    const name = area.toLowerCase();
    return withLock(name, async () => {
      const ctx = await loadContext(name);
      return compute(ctx, await signatureFor(ctx));
    });
  }

  /**
   * Recompute every area whose inputs changed (observations, status, groups, manual visits)
   * or whose prediction is at least 5 minutes old. One failing area never stops the others.
   */
  async function recomputeDue(): Promise<{ recomputed: string[]; failed: { area: string; error: unknown }[] }> {
    const recomputed: string[] = [];
    const failed: { area: string; error: unknown }[] = [];
    for (const area of await listAreaNames()) {
      try {
        const done = await withLock(area, async () => {
          const ctx = await loadContext(area);
          const signature = await signatureFor(ctx);
          const previous = await Prediction.findOne({ area }, { signature: 1, updatedAt: 1 }).lean();
          const fresh = previous && previous.signature === signature && now().getTime() - new Date(previous.updatedAt).getTime() < RECOMPUTE_INTERVAL_MS;
          if (fresh) return false;
          await compute(ctx, signature);
          return true;
        });
        if (done) recomputed.push(area);
      } catch (error) {
        failed.push({ area, error });
      }
    }
    return { recomputed, failed };
  }

  return { recomputeArea, recomputeDue };
}
