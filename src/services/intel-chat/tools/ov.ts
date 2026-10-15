import { jsonSchema, tool } from "ai";
import { AREAS, areaTitle, type AreaName } from "../../../constants/areas";
import { formatRdAnswer, toRd } from "../../rd-answer";
import { loadGroups } from "../data";
import { coordinateAt, estimateArea, metresBetween, parseCoordinate, type AreaGroup, type LatLng } from "../geo";
import {
  hhmm,
  isoAmsterdam,
  knownModes,
  loadNsStations,
  loadStopAreas,
  NS_MAX_JOURNEYS,
  nsDepartures,
  nsJourney,
  OV_MODES,
  OvBudgetError,
  ovapiJourneyStops,
  ovapiPasses,
  parseOvTime,
  type OvMode,
  type OvPass,
  type OvSession,
  type OvStopInfo,
} from "../ov.client";
import { arrivalAt, departAt, positionAt, shiftTrip, stopStatuses, type Trip, type TripStop } from "../ov-trip";
import { geocode } from "../pdok.client";
import { pointResult, type PointResult } from "../point";
import { areasOverview } from "./app-data";
import { createTurnBudget, safely, spend, ToolInputError, type IntelToolContext, type TurnBudget } from "./context";
import { POINT_DESCRIPTION, readArea, readPoint } from "./map";

const NO_KEY_NOTE = "Geen NS_API_KEY ingesteld: treinen en treinstations ontbreken, alleen bus/tram/metro/boot (OVapi)";
const NS_DOWN_NOTE = "NS-API niet bereikbaar: treinen en treinstations ontbreken";
const OVAPI_PAST_NOTE = "OVapi kent alleen actuele en komende ritten; eerdere bus-/tramvertrekken ontbreken";
const MAX_STOPS = 20;
const MAX_DEPARTURES = 30;
const MAX_CANDIDATES = 10;
/** Stops of the other source this close to the asked stop count as the same place (bus station beside a train station) */
const COMPANION_M = 300;
/** Timing points this far from the straight line to the destination may be on the route */
const CORRIDOR_M = 3000;
/** Straight-line speed (km/h) to estimate a run's end when OVapi gives no stop list */
const STRAIGHT_KMH: Record<OvMode, number> = { BUS: 20, TRAM: 15, METRO: 30, BOAT: 12, TRAIN: 60 };
const MODE_WORD: Record<OvMode, string> = { BUS: "bus", TRAM: "tram", METRO: "metro", BOAT: "boot", TRAIN: "trein" };
const WALK_M_PER_MIN = 5000 / 60;
const DETOUR = 1.3;
const MIN = 60_000;

export interface OvStop {
  id: string;
  name: string;
  town: string | null;
  latLng: LatLng;
  rdText: string;
  distanceM: number;
  modes: OvMode[];
}

function session(ctx: IntelToolContext, budget: TurnBudget, signal?: AbortSignal): OvSession {
  const key = (ctx.nsApiKey !== undefined ? ctx.nsApiKey : process.env.NS_API_KEY)?.trim();
  return { fetch: ctx.fetch ?? fetch, signal, now: ctx.now, nsKey: key || null, spend: () => spend(budget, "ov") };
}

const round6 = (latLng: LatLng): LatLng => ({ lat: Number(latLng.lat.toFixed(6)), lng: Number(latLng.lng.toFixed(6)) });
const modesOf = (stop: OvStopInfo): OvMode[] => (stop.source === "NS" ? ["TRAIN"] : (knownModes(stop.id) ?? []));
/** "Station Zutphen"; "Deventer, Station" stays as it is */
const stopLabel = (stop: { name: string; town: string | null }) => (stop.town && !stop.name.toLowerCase().includes(stop.town.toLowerCase()) ? `${stop.name} ${stop.town}` : stop.name);
const toOvStop = (stop: OvStopInfo, distanceM: number): OvStop => ({
  id: stop.id,
  name: stop.name,
  town: stop.town,
  latLng: round6(stop.latLng),
  rdText: formatRdAnswer(stop.latLng.lng, stop.latLng.lat),
  distanceM,
  modes: modesOf(stop),
});
const walkMinutes = (distanceM: number) => Math.max(1, Math.round((distanceM * DETOUR) / WALK_M_PER_MIN));
const delayMin = (planned: Date, expected: Date) => Math.round((expected.getTime() - planned.getTime()) / MIN);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** A point, or the first PDOK hit for a place name */
async function resolveNear(ctx: IntelToolContext, input: unknown, signal?: AbortSignal): Promise<LatLng> {
  const nearText = String(input ?? "").trim();
  if (!nearText) throw new ToolInputError("Geef een punt of plaatsnaam");
  const parsed = parseCoordinate(nearText);
  if (parsed) return parsed.latLng;
  const hit = (await geocode(nearText, { fetch: ctx.fetch, signal }))[0];
  if (!hit) throw new ToolInputError(`Plaats "${nearText.slice(0, 60)}" niet gevonden`);
  return hit.latLng;
}

/** OVapi stop areas plus NS stations; a source that fails becomes a note (both failing is an error) */
async function allStops(s: OvSession): Promise<{ stops: OvStopInfo[]; notes: string[] }> {
  const notes: string[] = [];
  let areas: OvStopInfo[] = [];
  let ovapiError: unknown = null;
  try {
    areas = await loadStopAreas(s);
  } catch (error) {
    if (error instanceof OvBudgetError) throw error;
    ovapiError = error;
  }
  let stations: OvStopInfo[] = [];
  if (!s.nsKey) notes.push(NO_KEY_NOTE);
  else {
    try {
      stations = await loadNsStations(s);
    } catch (error) {
      if (error instanceof OvBudgetError) throw error;
      if (ovapiError) throw ovapiError;
      notes.push(NS_DOWN_NOTE);
    }
  }
  if (ovapiError) {
    if (stations.length === 0) throw ovapiError;
    notes.push(`${(ovapiError as Error).message}: bussen en trams ontbreken`);
  }
  return { stops: [...areas, ...stations], notes };
}

const within = (stops: OvStopInfo[], center: LatLng, radiusM: number) =>
  stops
    .map((stop) => ({ stop, distanceM: metresBetween(center, stop.latLng) }))
    .filter((entry) => entry.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM);

/** Fill the modes of OVapi stops from their passes (one request); a failure leaves them unknown and gives a note */
async function learnModes(s: OvSession, stops: OvStopInfo[]): Promise<string | null> {
  const codes = stops.filter((stop) => stop.source === "OVAPI").map((stop) => stop.id);
  if (codes.length === 0) return null;
  try {
    await ovapiPasses(s, codes);
    return null;
  } catch (error) {
    const reason = error instanceof OvBudgetError ? "limiet voor deze vraag bereikt" : error instanceof ToolInputError ? error.message : "OVapi niet bereikbaar";
    return `Vervoerswijzen van bushaltes onbekend: ${reason}`;
  }
}

// --- ovStopsNear -------------------------------------------------------------------------------------------------

export async function ovStopsNear(ctx: IntelToolContext, budget: TurnBudget, input: { near: string; radiusM?: number }, signal?: AbortSignal): Promise<{ stops: OvStop[]; note?: string }> {
  const radiusM = Math.round(clamp(Number(input.radiusM) || 1000, 50, 5000));
  const center = await resolveNear(ctx, input.near, signal);
  const s = session(ctx, budget, signal);
  const { stops, notes } = await allStops(s);
  const near = within(stops, center, radiusM).slice(0, MAX_STOPS);
  const modesNote = await learnModes(
    s,
    near.map((entry) => entry.stop),
  );
  if (modesNote) notes.push(modesNote);
  return { stops: near.map((entry) => toOvStop(entry.stop, entry.distanceM)), ...(notes.length > 0 ? { note: notes.join(". ") } : {}) };
}

// --- ovDepartures ------------------------------------------------------------------------------------------------

export interface OvDeparture {
  mode: OvMode;
  line: string;
  destination: string;
  planned: string;
  expected: string;
  delayMin: number;
  status: string;
  journeyId: string | null;
  platform?: string;
}

/** A departure with Dates (internal), and where it leaves from */
interface Dep {
  stop: OvStopInfo;
  mode: OvMode;
  line: string;
  destination: string;
  planned: Date;
  expected: Date;
  status: string;
  platform?: string;
  cancelled: boolean;
  journeyId: string;
  /** OVapi: pass key (journey) */
  key?: string;
  /** NS: train number and day */
  train?: string;
  date?: string;
}

const ovapiJourneyId = (key: string, code: string) => `OVAPI:${key}@${code}`;

function depsFromPasses(passes: OvPass[], stopsById: Map<string, OvStopInfo>): Dep[] {
  const seen = new Set<string>();
  return passes.flatMap((pass): Dep[] => {
    const stop = stopsById.get(pass.stopAreaCode);
    const expected = pass.expectedDep;
    if (!stop || !expected || pass.stopType === "LAST" || seen.has(pass.key)) return [];
    seen.add(pass.key);
    return [
      {
        stop,
        mode: pass.mode,
        line: pass.line,
        destination: pass.destination,
        planned: pass.plannedDep ?? expected,
        expected,
        status: pass.status,
        cancelled: pass.status === "CANCEL",
        journeyId: ovapiJourneyId(pass.key, pass.stopAreaCode),
        key: pass.key,
      },
    ];
  });
}

/** OVapi passes and NS departures of these stops (NS from `from`, default now) */
async function departuresAt(s: OvSession, ovapiStops: OvStopInfo[], station: OvStopInfo | null, from?: Date): Promise<{ deps: Dep[]; notes: string[] }> {
  const notes: string[] = [];
  const deps: Dep[] = [];
  if (ovapiStops.length > 0) {
    const passes = await ovapiPasses(
      s,
      ovapiStops.map((stop) => stop.id),
    );
    deps.push(...depsFromPasses(passes, new Map(ovapiStops.map((stop) => [stop.id, stop]))));
  }
  if (station && s.nsKey) {
    try {
      const code = station.id.slice(3);
      for (const departure of await nsDepartures(s, code, from)) {
        deps.push({
          stop: station,
          mode: "TRAIN",
          line: departure.line,
          destination: departure.destination,
          planned: departure.planned,
          expected: departure.expected,
          status: departure.status,
          ...(departure.platform ? { platform: departure.platform } : {}),
          cancelled: departure.cancelled,
          journeyId: `NS:${departure.train}:${departure.date}`,
          train: departure.train,
          date: departure.date,
        });
      }
    } catch (error) {
      if (error instanceof OvBudgetError || ovapiStops.length === 0) throw error;
      notes.push(NS_DOWN_NOTE);
    }
  }
  return { deps, notes };
}

const toOvDeparture = (dep: Dep): OvDeparture => ({
  mode: dep.mode,
  line: dep.line,
  destination: dep.destination,
  planned: isoAmsterdam(dep.planned),
  expected: isoAmsterdam(dep.expected),
  delayMin: delayMin(dep.planned, dep.expected),
  status: dep.status,
  journeyId: dep.journeyId,
  ...(dep.platform ? { platform: dep.platform } : {}),
});

export async function ovDepartures(
  ctx: IntelToolContext,
  budget: TurnBudget,
  input: { stop: string; windowMin?: number; fromTime?: string },
  signal?: AbortSignal,
): Promise<{ stop: OvStop; departures: OvDeparture[]; note?: string }> {
  const windowMin = Math.round(clamp(Number(input.windowMin) || 60, 5, 180));
  const now = ctx.now();
  let from = now;
  if (input.fromTime !== undefined && input.fromTime !== null && input.fromTime !== "") {
    const parsed = parseOvTime(input.fromTime);
    if (!parsed) throw new ToolInputError("fromTime moet een tijd zijn (ISO 8601, bv. 2026-10-17T14:05:00+02:00)");
    from = parsed;
  }
  const id = String(input.stop ?? "").trim();
  if (!id) throw new ToolInputError("Geef bij stop een halte-id, punt of plaatsnaam");
  const s = session(ctx, budget, signal);
  if (id.startsWith("NS:") && !s.nsKey) throw new ToolInputError("Geen NS_API_KEY ingesteld: treinvertrektijden zijn niet beschikbaar");
  const { stops, notes } = await allStops(s);
  let chosen = stops.find((stop) => stop.id === id);
  let distanceM = 0;
  if (!chosen) {
    if (id.startsWith("NS:")) throw new ToolInputError(`Station ${id.slice(3, 20)} niet gevonden`);
    const center = await resolveNear(ctx, id, signal);
    const nearest = within(stops, center, 5000)[0];
    if (!nearest) throw new ToolInputError("Geen halte of station binnen 5 km");
    chosen = nearest.stop;
    distanceM = nearest.distanceM;
  }
  // The stop plus the stops of the other source right beside it (bus station at a train station)
  const beside = within(stops, chosen.latLng, COMPANION_M).map((entry) => entry.stop);
  const ovapiStops = [...new Set([chosen, ...beside].filter((stop) => stop.source === "OVAPI"))].slice(0, 5);
  const station = chosen.source === "NS" ? chosen : (beside.find((stop) => stop.source === "NS") ?? null);
  const shifted = Math.abs(from.getTime() - now.getTime()) > MIN;
  const result = await departuresAt(s, ovapiStops, station, shifted ? from : undefined);
  const end = from.getTime() + windowMin * MIN;
  const departures = result.deps
    .filter((dep) => dep.expected.getTime() >= from.getTime() && dep.expected.getTime() <= end)
    .sort((a, b) => a.expected.getTime() - b.expected.getTime() || a.line.localeCompare(b.line))
    .slice(0, MAX_DEPARTURES)
    .map(toOvDeparture);
  const allNotes = [...notes, ...result.notes];
  // NS answers at most NS_MAX_JOURNEYS departures: then later trains in the window may be missing
  const trains = result.deps.filter((dep) => dep.train);
  const lastTrain = Math.max(...trains.map((dep) => dep.planned.getTime()));
  if (trains.length >= NS_MAX_JOURNEYS && lastTrain < end) allNotes.push(`NS gaf maximaal ${NS_MAX_JOURNEYS} treinvertrekken (tot ${hhmm(new Date(lastTrain))}); latere treinen binnen het venster ontbreken`);
  if (ovapiStops.length > 0 && from.getTime() < now.getTime() - 2 * MIN) allNotes.push(OVAPI_PAST_NOTE);
  return { stop: toOvStop(chosen, distanceM), departures, ...(allNotes.length > 0 ? { note: allNotes.join(". ") } : {}) };
}

// --- Trips (ovJourney, predictOvMovement) ------------------------------------------------------------------------

type JourneyRef = { kind: "ns"; train: string; date: string } | { kind: "ovapi"; key: string; code: string | null };

function readJourneyId(input: unknown): JourneyRef {
  const id = String(input ?? "").trim();
  const ns = /^NS:(\d{1,6}):(\d{4}-\d{2}-\d{2})$/.exec(id);
  if (ns) return { kind: "ns", train: ns[1], date: ns[2] };
  if (id.startsWith("OVAPI:")) {
    // Stop area codes may hold spaces, '&' or '+' ("Bd CS", "W&aAnj"): split on the last '@'
    const rest = id.slice("OVAPI:".length);
    const at = rest.lastIndexOf("@");
    const key = at < 0 ? rest : rest.slice(0, at);
    const code = at < 0 ? null : rest.slice(at + 1);
    if (/^[\w:.-]{3,80}$/.test(key) && (code === null || /^[\x20-\x7e]{1,40}$/.test(code))) return { kind: "ovapi", key, code };
  }
  throw new ToolInputError("Onbekende journeyId; gebruik er een uit ovDepartures of predictOvMovement");
}

const normalise = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Where a destination sign ("Deventer", "Arnhem Centraal", "Warnsveld") is: an OVapi stop area, an NS station, else PDOK */
async function resolveDestination(ctx: IntelToolContext, s: OvSession, destination: string, near: LatLng): Promise<{ name: string; town: string | null; latLng: LatLng } | null> {
  const wanted = normalise(destination);
  if (!wanted) return null;
  const close = (latLng: LatLng) => metresBetween(near, latLng) <= 150_000;
  const scored = (await loadStopAreas(s))
    .filter((area) => close(area.latLng))
    .map((area) => {
      const name = normalise(area.name);
      const town = normalise(area.town ?? "");
      let score = 0;
      if (name === wanted || `${town} ${name}` === wanted) score = 3;
      else if (town && wanted.startsWith(`${town} `) && name.includes(wanted.slice(town.length + 1))) score = 2.5;
      else if (town === wanted) score = /station|centrum|centraal|busstation/.test(name) ? 2.2 : 2;
      return { area, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || metresBetween(near, a.area.latLng) - metresBetween(near, b.area.latLng));
  if (scored[0]) return { name: scored[0].area.name, town: scored[0].area.town, latLng: scored[0].area.latLng };
  // NS being down must not break a bus journey: then no stations
  const stations = await loadNsStations(s).catch((error) => {
    if (error instanceof OvBudgetError) throw error;
    return [] as OvStopInfo[];
  });
  const station = stations.find((candidate) => normalise(candidate.name) === wanted && close(candidate.latLng));
  if (station) return { name: station.name, town: null, latLng: station.latLng };
  const hit = (await geocode(destination, { fetch: ctx.fetch, signal: s.signal }).catch(() => []))[0];
  return hit && close(hit.latLng) ? { name: destination, town: null, latLng: hit.latLng } : null;
}

const passStop = (pass: OvPass, estimated = false): TripStop => ({
  name: pass.name,
  town: pass.town,
  latLng: pass.latLng,
  plannedArr: pass.plannedArr,
  arr: pass.expectedArr,
  plannedDep: pass.stopType === "LAST" ? null : pass.plannedDep,
  dep: pass.stopType === "LAST" ? null : pass.expectedDep,
  cancelled: pass.status === "CANCEL",
  key: pass.stopAreaCode,
  ...(estimated ? { estimated } : {}),
});

/** Distance from p to the segment a-b in RD metres and the position along it (0 = a, 1 = b) */
function alongSegment(p: LatLng, a: LatLng, b: LatLng): { distance: number; t: number } {
  const [P, A, B] = [p, a, b].map((point) => toRd(point.lng, point.lat));
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const lengthSq = dx * dx + dy * dy || 1;
  const t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / lengthSq;
  const c = Math.max(0, Math.min(1, t));
  return { distance: Math.hypot(P.x - (A.x + c * dx), P.y - (A.y + c * dy)), t };
}

/**
 * An OVapi journey. OVapi's /journey gives no stops any more, so then: the pass at the asked stop, the timing points
 * along the straight line to the destination that list the same journey (one request), and the destination itself
 * at a straight-line speed estimate.
 */
async function ovapiTrip(ctx: IntelToolContext, s: OvSession, key: string, code: string | null): Promise<Trip> {
  const journeyId = ovapiJourneyId(key, code ?? "");
  const real = await ovapiJourneyStops(s, key);
  if (real.length >= 2) {
    return { mode: real[0].mode, line: real[0].line, destination: real[0].destination, stops: real.map((pass) => passStop(pass)), estimated: false, journeyId: code ? journeyId : `OVAPI:${key}` };
  }
  const gone = new ToolInputError("Deze rit staat niet (meer) bij OVapi; OVapi kent alleen actuele en komende ritten");
  if (!code) throw gone;
  const origin = (await ovapiPasses(s, [code])).find((pass) => pass.key === key);
  if (!origin || !origin.latLng) throw gone;
  const stops: TripStop[] = [passStop(origin)];
  const terminus = await resolveDestination(ctx, s, origin.destination, origin.latLng);
  if (terminus) {
    const corridor = (await loadStopAreas(s))
      .filter((area) => area.id !== code)
      .map((area) => ({ area, ...alongSegment(area.latLng, origin.latLng!, terminus.latLng) }))
      .filter((entry) => entry.distance <= CORRIDOR_M && entry.t > 0.02 && entry.t <= 1.05)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 40);
    if (corridor.length > 0) {
      const later = (await ovapiPasses(
        s,
        corridor.map((entry) => entry.area.id),
      )).filter((pass) => pass.key === key && pass.order > origin.order);
      const byOrder = new Map(later.map((pass) => [pass.order, pass]));
      stops.push(...[...byOrder.values()].sort((a, b) => a.order - b.order).map((pass) => passStop(pass)));
    }
    const last = stops[stops.length - 1];
    const lastTime = departAt(last);
    if (last.latLng && lastTime && metresBetween(last.latLng, terminus.latLng) > 300) {
      const minutes = Math.max(1, Math.round(metresBetween(last.latLng, terminus.latLng) / 1000 / STRAIGHT_KMH[origin.mode] * 60));
      const arrival = new Date(lastTime.getTime() + minutes * MIN);
      stops.push({ name: terminus.name, town: terminus.town, latLng: terminus.latLng, plannedArr: null, arr: arrival, plannedDep: null, dep: null, cancelled: false, estimated: true });
    }
  }
  return { mode: origin.mode, line: origin.line, destination: origin.destination, stops, estimated: true, journeyId };
}

async function tripOf(ctx: IntelToolContext, s: OvSession, ref: JourneyRef): Promise<Trip> {
  return ref.kind === "ns" ? await nsJourney(s, ref.train, ref.date) : await ovapiTrip(ctx, s, ref.key, ref.code);
}

const ESTIMATE_NOTE = "Ritverloop geschat: OVapi geeft geen haltelijst; tussenhaltes alleen waar OVapi ze kent, verder een rechte lijn naar de bestemming";

export interface OvJourneyResult {
  mode: OvMode;
  line: string;
  destination: string;
  stops: { name: string; town: string | null; latLng: LatLng | null; planned: string | null; expected: string | null; status: string }[];
  current: { latLng: LatLng; rdText: string; between: [string, string]; note: string } | null;
  note?: string;
}

/** "tussen A en B, ~N min tot B" / "staat in A, vertrekt over ~N min" */
function currentOf(trip: Trip, now: Date): OvJourneyResult["current"] {
  const position = positionAt(trip, now);
  if (!position || position.state === "before" || position.state === "after") return null;
  const labels = trip.stops.map(stopLabel);
  const next = labels[position.nextIndex];
  const previous = position.state === "atStop" ? next : labels[trip.stops.findLastIndex((stop, index) => index < position.nextIndex && !stop.cancelled && stop.latLng)];
  const guess = trip.estimated ? " (geschat)" : "";
  const note = position.state === "atStop" ? `staat in ${next}, vertrekt over ~${position.minutesToNext} min${guess}` : `tussen ${previous} en ${next}, ~${position.minutesToNext} min tot ${next}${guess}`;
  return { latLng: position.latLng, rdText: formatRdAnswer(position.latLng.lng, position.latLng.lat), between: [previous, next], note };
}

export async function ovJourney(ctx: IntelToolContext, budget: TurnBudget, input: { journeyId: string }, signal?: AbortSignal): Promise<OvJourneyResult> {
  const ref = readJourneyId(input.journeyId);
  const s = session(ctx, budget, signal);
  if (ref.kind === "ns" && !s.nsKey) throw new ToolInputError("Geen NS_API_KEY ingesteld: treinritten zijn niet beschikbaar");
  const trip = await tripOf(ctx, s, ref);
  const now = ctx.now();
  const statuses = stopStatuses(trip, now);
  const notes: string[] = [];
  if (trip.estimated) notes.push(ESTIMATE_NOTE);
  const position = positionAt(trip, now);
  if (position?.state === "before") notes.push(`Rit is nog niet vertrokken (vertrek ${hhmm(departAt(trip.stops[0])!)} uit ${stopLabel(trip.stops[0])})`);
  if (position?.state === "after") notes.push(`Rit is aangekomen in ${stopLabel(trip.stops[trip.stops.length - 1])}`);
  return {
    mode: trip.mode,
    line: trip.line,
    destination: trip.destination,
    stops: trip.stops.map((stop, index) => {
      const planned = stop.plannedDep ?? stop.plannedArr;
      const expected = stop.dep ?? stop.arr;
      return { name: stop.name, town: stop.town, latLng: stop.latLng ? round6(stop.latLng) : null, planned: planned ? isoAmsterdam(planned) : null, expected: expected ? isoAmsterdam(expected) : null, status: statuses[index] };
    }),
    current: currentOf(trip, now),
    ...(notes.length > 0 ? { note: notes.join(". ") } : {}),
  };
}

// --- predictOvMovement -------------------------------------------------------------------------------------------

export interface OvCandidate {
  point: PointResult;
  via: string;
  kind: "onboard" | "alighted" | "terminus" | "waiting";
  atTime: string;
  score: number;
  why: string;
  journeyId: string | null;
}

const MAX_SEEN_AGE_MS = 6 * 60 * MIN;
const CATCH_WINDOW_MS = 90 * MIN;
const MAX_FOLLOW = 6;
const MAX_NEAR_STOPS = 6;
const WAIT_WINDOW_MS = 30 * MIN;

/** A departure the fox team may have taken (or may still take), from one of the stops within walking distance */
interface Option {
  dep: Dep;
  walkM: number;
  walkMin: number;
  /** Derived from the timetable interval: the trip of `baseKey` shifted by `shiftMs` */
  inferred?: { baseKey: string; shiftMs: number };
  prior: number;
}

function readModes(input: unknown): OvMode[] {
  if (input === undefined || input === null) return [...OV_MODES];
  if (!Array.isArray(input) || input.length === 0) throw new ToolInputError("modes moet een lijst van vervoerswijzen zijn");
  return input.map((mode) => {
    const upper = String(mode ?? "")
      .trim()
      .toUpperCase();
    if (!(OV_MODES as readonly string[]).includes(upper)) throw new ToolInputError(`Onbekende vervoerswijze: ${String(mode).slice(0, 20)}`);
    return upper as OvMode;
  });
}

const viaOf = (dep: Dep, at: Date) => `${MODE_WORD[dep.mode]} ${dep.line} → ${dep.destination} (vertrek ${hhmm(at)}, ${stopLabel(dep.stop)})`;

/** Earlier runs of each OVapi line, derived from the interval between its next two departures */
function inferEarlier(upcoming: Dep[], actual: Dep[], earliest: number, latest: number, now: number): { dep: Dep; shiftMs: number }[] {
  const groups = new Map<string, Dep[]>();
  for (const dep of upcoming) if (dep.key) groups.set(`${dep.stop.id}|${dep.line}|${dep.destination}`, [...(groups.get(`${dep.stop.id}|${dep.line}|${dep.destination}`) ?? []), dep]);
  const inferred: { dep: Dep; shiftMs: number }[] = [];
  for (const deps of groups.values()) {
    const sorted = deps.sort((a, b) => a.planned.getTime() - b.planned.getTime());
    if (sorted.length < 2) continue;
    const headway = sorted[1].planned.getTime() - sorted[0].planned.getTime();
    if (headway < 5 * MIN || headway > 120 * MIN) continue;
    for (let k = 1; k <= 4; k++) {
      const at = sorted[0].planned.getTime() - k * headway;
      if (at < earliest - MIN) break;
      if (at > latest || at >= now) continue;
      const taken = actual.some((dep) => dep.stop.id === sorted[0].stop.id && dep.line === sorted[0].line && Math.abs(dep.expected.getTime() - at) < 3 * MIN);
      if (!taken) inferred.push({ dep: { ...sorted[0], planned: new Date(at), expected: new Date(at), status: "AFGELEID" }, shiftMs: at - sorted[0].planned.getTime() });
    }
  }
  return inferred;
}

interface Scoring {
  groups: AreaGroup[];
  area?: string;
  allowed: Set<string> | null;
  bigStations: Set<string>;
}

/** 0..1: inside the asked area (or an allowed area), outside every area hull counts least */
function areaFactor(latLng: LatLng, scoring: Scoring): { factor: number; text: string } {
  if (!scoring.groups.some((group) => group.area)) return { factor: 1, text: "" };
  const estimate = estimateArea(latLng, scoring.groups);
  const inHull = estimate.method === "hull";
  const title = estimate.area ? areaTitle(estimate.area as AreaName) : "";
  const text = estimate.area ? (inHull ? `In deelgebied ${title}` : `Buiten de groepen; dichtst bij ${title}`) : "";
  if (scoring.area) return { factor: estimate.area === scoring.area ? (inHull ? 1 : 0.75) : inHull ? 0.4 : 0.5, text };
  if (!inHull) return { factor: 0.6, text };
  return { factor: !scoring.allowed || scoring.allowed.has(estimate.area!) ? 1 : 0.8, text };
}

export async function predictOvMovement(
  ctx: IntelToolContext,
  budget: TurnBudget,
  input: { from: string; seenAt: string; maxWalkM?: number; area?: string; modes?: string[] },
  signal?: AbortSignal,
): Promise<{ candidates: OvCandidate[]; assumptions: string[]; note?: string }> {
  const from = readPoint(input.from, "from").latLng;
  const seen = parseOvTime(input.seenAt);
  if (!seen) throw new ToolInputError("seenAt moet een tijd zijn (ISO 8601, bv. 2026-10-17T14:05:00+02:00)");
  const now = ctx.now();
  if (seen.getTime() > now.getTime() + 5 * MIN) throw new ToolInputError("seenAt ligt in de toekomst");
  if (now.getTime() - seen.getTime() > MAX_SEEN_AGE_MS) throw new ToolInputError("seenAt is meer dan 6 uur geleden; te oud om te voorspellen");
  const maxWalkM = Math.round(clamp(Number(input.maxWalkM) || 800, 100, 3000));
  const area = readArea(input.area);
  const modes = new Set(readModes(input.modes));
  const s = session(ctx, budget, signal);
  const windowEnd = Math.min(now.getTime(), seen.getTime() + CATCH_WINDOW_MS);
  const assumptions = [`Lopen naar haltes binnen ${maxWalkM} m met 5 km/u (hemelsbreed × 1,3)`, `Vertrekken tussen ${hhmm(seen)} en ${hhmm(new Date(windowEnd))} meegenomen`];
  if (modes.size < OV_MODES.length) assumptions.push(`Alleen ${[...modes].map((mode) => MODE_WORD[mode]).join(", ")}`);

  const { stops, notes } = await allStops(s);
  const near = within(stops, from, maxWalkM)
    .filter((entry) => (entry.stop.source === "NS" ? modes.has("TRAIN") : [...modes].some((mode) => mode !== "TRAIN")))
    .slice(0, MAX_NEAR_STOPS);
  if (near.length === 0) return { candidates: [], assumptions, note: [`Geen halte of station binnen ${maxWalkM} m van het punt`, ...notes].join(". ") };
  const walkOf = new Map(near.map((entry) => [entry.stop.id, { walkM: entry.distanceM, walkMin: walkMinutes(entry.distanceM) }]));

  // Departures: OVapi (current and upcoming only) and NS (from seenAt)
  const ovapiStops = near.map((entry) => entry.stop).filter((stop) => stop.source === "OVAPI");
  const stations = near
    .map((entry) => entry.stop)
    .filter((stop) => stop.source === "NS")
    .slice(0, 2);
  const deps: Dep[] = [];
  const ovapiDeps = ovapiStops.length > 0 ? (await departuresAt(s, ovapiStops, null)).deps : [];
  deps.push(...ovapiDeps);
  for (const station of stations) {
    try {
      deps.push(...(await departuresAt(s, [], station, seen)).deps);
    } catch (error) {
      if (error instanceof OvBudgetError && deps.length === 0) throw error;
      notes.push(error instanceof OvBudgetError ? "Limiet van 25 OV-verzoeken bereikt: niet alle stations bekeken" : NS_DOWN_NOTE);
      break;
    }
  }
  const usable = deps.filter((dep) => modes.has(dep.mode) && !dep.cancelled);
  const earliestOf = (dep: Dep) => seen.getTime() + walkOf.get(dep.stop.id)!.walkMin * MIN;
  const actual = usable.filter((dep) => dep.expected.getTime() >= earliestOf(dep) - MIN && dep.expected.getTime() <= windowEnd);
  const upcoming = usable.filter((dep) => dep.expected.getTime() > now.getTime());
  const inferred = inferEarlier(
    upcoming.filter((dep) => dep.key),
    actual,
    seen.getTime() + Math.min(...ovapiStops.map((stop) => walkOf.get(stop.id)!.walkMin)) * MIN,
    windowEnd,
    now.getTime(),
  ).filter(({ dep }) => dep.expected.getTime() >= earliestOf(dep) - MIN);
  if (ovapiStops.length > 0) assumptions.push("OVapi kent alleen actuele en komende ritten: eerdere bussen/trams zijn afgeleid uit het interval van de komende ritten");

  const prior = (dep: Dep, isInferred: boolean) => {
    const walk = walkOf.get(dep.stop.id)!;
    const slackMin = (dep.expected.getTime() - earliestOf(dep)) / MIN;
    return clamp(1 - slackMin / 60, 0.25, 1) * (1 - (0.4 * walk.walkM) / maxWalkM) * (isInferred ? 0.7 : 1);
  };
  const options: Option[] = [
    ...actual.map((dep) => ({ dep, ...walkOf.get(dep.stop.id)!, prior: prior(dep, false) })),
    ...inferred.map(({ dep, shiftMs }) => ({ dep, ...walkOf.get(dep.stop.id)!, inferred: { baseKey: dep.key!, shiftMs }, prior: prior(dep, true) })),
  ].sort((a, b) => b.prior - a.prior);

  const groups = await loadGroups();
  const allowed = area ? null : await areasOverview().then((overview) => (overview.huntableConfigured ? new Set(overview.areas.filter((entry) => entry.allowed).map((entry) => entry.area as string)) : null));
  const scoring: Scoring = { groups, area, allowed, bigStations: new Set(stops.filter((stop) => stop.big && stop.uic).map((stop) => stop.uic!)) };
  const candidates: (OvCandidate & { sortKey: string })[] = [];
  const add = (latLng: LatLng, label: string, kind: OvCandidate["kind"], at: Date, base: number, why: string[], via: string, journeyId: string | null, rideMin: number, big: boolean) => {
    const { factor, text } = areaFactor(latLng, scoring);
    const ride = rideMin > 30 && factor < 0.9 ? 0.8 : 1;
    const score = Math.round(clamp(base * factor * ride + (big ? 0.05 : 0), 0, 1) * 100) / 100;
    candidates.push({
      point: pointResult(coordinateAt(latLng), label, groups),
      via,
      kind,
      atTime: isoAmsterdam(at),
      score,
      why: [...why, text].filter(Boolean).join("; "),
      journeyId,
      sortKey: `${kind}|${journeyId ?? via}|${label}`,
    });
  };

  // Follow the most plausible departures
  const trips = new Map<string, Promise<Trip>>();
  const tripFor = (ref: JourneyRef, cacheKey: string) => {
    if (!trips.has(cacheKey)) trips.set(cacheKey, tripOf(ctx, s, ref));
    return trips.get(cacheKey)!;
  };
  let budgetHit = false;
  let skipped = 0;
  let estimated = false;
  for (const option of options.slice(0, MAX_FOLLOW)) {
    const { dep } = option;
    let trip: Trip;
    try {
      if (dep.train && dep.date) trip = await tripFor({ kind: "ns", train: dep.train, date: dep.date }, dep.journeyId);
      else {
        const key = option.inferred?.baseKey ?? dep.key!;
        const base = await tripFor({ kind: "ovapi", key, code: dep.stop.id }, ovapiJourneyId(key, dep.stop.id));
        trip = option.inferred ? shiftTrip(base, option.inferred.shiftMs, "") : base;
      }
    } catch (error) {
      if (error instanceof OvBudgetError) {
        budgetHit = true;
        break;
      }
      if (!(error instanceof ToolInputError)) throw error;
      skipped++;
      continue;
    }
    estimated ||= trip.estimated;
    let board = trip.stops.findIndex((stop) => (dep.stop.uic ? stop.key === dep.stop.uic : stop.key === dep.stop.id));
    if (board < 0) board = 0;
    const ride: Trip = { ...trip, stops: trip.stops.slice(board) };
    const journeyId = option.inferred ? null : dep.journeyId;
    const via = viaOf(dep, dep.expected);
    const slack = Math.max(0, Math.round((dep.expected.getTime() - earliestOf(dep)) / MIN));
    const why = [
      `Gezien ${hhmm(seen)}; ${option.walkM} m naar ${stopLabel(dep.stop)} (~${option.walkMin} min lopen); vertrek ${hhmm(dep.expected)} (${slack} min speling)${option.inferred ? ", eerdere rit afgeleid uit de dienstregeling" : ""}`,
    ];
    const rideMin = (at: Date) => (at.getTime() - dep.expected.getTime()) / MIN;

    const position = positionAt(ride, now);
    if (position && (position.state === "moving" || position.state === "atStop")) {
      const current = currentOf(ride, now)!;
      add(position.latLng, `In ${MODE_WORD[dep.mode]} ${dep.line} → ${dep.destination}`, "onboard", now, option.prior, [...why, `Nu ${current.note}`], via, journeyId, rideMin(now), false);
    }
    const last = ride.stops.length - 1;
    const alighted = ride.stops
      .map((stop, index) => ({ stop, index }))
      .filter(({ stop, index }) => index > 0 && index < last && !stop.cancelled && stop.latLng && arrivalAt(stop) && arrivalAt(stop)!.getTime() <= now.getTime());
    for (const { stop } of alighted) {
      const at = arrivalAt(stop)!;
      const big = !!stop.key && scoring.bigStations.has(stop.key);
      add(stop.latLng!, `Uitgestapt ${stopLabel(stop)}`, "alighted", at, option.prior * 0.5, [...why, `Kan om ${hhmm(at)} zijn uitgestapt in ${stopLabel(stop)}`], via, journeyId, rideMin(at), big);
    }
    const end = ride.stops[last];
    const endAt = arrivalAt(end);
    if (last > 0 && end.latLng && endAt && !end.cancelled) {
      const arrived = endAt.getTime() <= now.getTime();
      const big = !!end.key && scoring.bigStations.has(end.key);
      const what = `${arrived ? "Eindpunt, aangekomen" : "Eindpunt, aankomst"} ${hhmm(endAt)}${end.estimated ? " (geschat)" : ""}`;
      add(end.latLng, `Eindpunt ${stopLabel(end)}`, "terminus", endAt, option.prior * (arrived ? 0.85 : 0.55), [...why, what], via, journeyId, rideMin(endAt), big);
    }
  }

  // Still waiting at a stop for the next departure (likely only when seen recently)
  const atStopMin = (stopId: string) => (now.getTime() - seen.getTime()) / MIN - walkOf.get(stopId)!.walkMin;
  const waiting = upcoming.filter((dep) => dep.expected.getTime() <= now.getTime() + WAIT_WINDOW_MS).sort((a, b) => a.expected.getTime() - b.expected.getTime());
  const perStop = new Map<string, number>();
  for (const dep of waiting) {
    const count = perStop.get(dep.stop.id) ?? 0;
    if (count >= 2) continue;
    perStop.set(dep.stop.id, count + 1);
    const walk = walkOf.get(dep.stop.id)!;
    const recency = clamp(1 - Math.max(0, atStopMin(dep.stop.id)) / 30, 0.05, 1);
    const base = 0.9 * recency * (1 - (0.4 * walk.walkM) / maxWalkM) * (count === 0 ? 1 : 0.8);
    add(dep.stop.latLng, `Wacht bij ${stopLabel(dep.stop)}`, "waiting", now, base, [`Gezien ${hhmm(seen)}; ${walk.walkM} m naar ${stopLabel(dep.stop)}; wacht mogelijk nog op het vertrek van ${hhmm(dep.expected)}`], viaOf(dep, dep.expected), dep.journeyId, 0, false);
  }

  if (estimated) assumptions.push("Busritten zonder haltelijst: tussenhaltes alleen waar OVapi ze kent, verder een rechte lijn naar de bestemming met ~20 km/u");
  if (budgetHit) assumptions.push("Limiet van 25 OV-verzoeken bereikt: niet alle ritten gevolgd");
  if (skipped > 0) assumptions.push(`${skipped} ${skipped === 1 ? "rit kon" : "ritten konden"} niet gevolgd worden`);
  const unique = new Map<string, OvCandidate & { sortKey: string }>();
  for (const candidate of candidates) if (!unique.has(candidate.sortKey) || unique.get(candidate.sortKey)!.score < candidate.score) unique.set(candidate.sortKey, candidate);
  const best = [...unique.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES)
    .map(({ sortKey: _sortKey, ...candidate }) => candidate);
  return { candidates: best, assumptions, ...(notes.length > 0 ? { note: notes.join(". ") } : {}) };
}

// --- Tools -------------------------------------------------------------------------------------------------------

const MODES_SCHEMA = { type: "array" as const, items: { type: "string" as const, enum: [...OV_MODES] }, description: "Alleen deze vervoerswijzen (standaard alle)" };

export function ovTools(turn: IntelToolContext) {
  const ctx: IntelToolContext = { ...turn, budget: turn.budget ?? createTurnBudget() };
  const budget = ctx.budget!;
  return {
    ovStopsNear: tool({
      description: "Bus-, tram-, metro- en bootaltes (OVapi) en treinstations (NS) rond een punt of plaats, dichtstbijzijnde eerst (max 20), met vervoerswijzen (leeg = onbekend). id gebruik je in ovDepartures.",
      inputSchema: jsonSchema<{ near: string; radiusM?: number }>({
        type: "object",
        properties: { near: { type: "string", description: `${POINT_DESCRIPTION}, of een plaatsnaam/adres` }, radiusM: { type: "number", description: "Straal in meters (standaard 1000, max 5000)" } },
        required: ["near"],
      }),
      execute: (input, { abortSignal }) => safely("ovStopsNear", () => ovStopsNear(ctx, budget, input, abortSignal)),
    }),
    ovDepartures: tool({
      description:
        "Vertrektijden bij een halte of station (bus/tram via OVapi, treinen via NS), ook van de haltes er direct naast; gesorteerd op verwachte tijd, met vertraging en journeyId voor ovJourney. OVapi kent alleen actuele en komende ritten.",
      inputSchema: jsonSchema<{ stop: string; windowMin?: number; fromTime?: string }>({
        type: "object",
        properties: {
          stop: { type: "string", description: `Halte-id uit ovStopsNear (bv. "ZpBus" of "NS:ZP"), of een punt/plaatsnaam (dan de dichtstbijzijnde halte). ${POINT_DESCRIPTION}` },
          windowMin: { type: "number", description: "Minuten vanaf fromTime (standaard 60, max 180)" },
          fromTime: { type: "string", description: "Vanaf deze tijd (ISO 8601, standaard nu)" },
        },
        required: ["stop"],
      }),
      execute: (input, { abortSignal }) => safely("ovDepartures", () => ovDepartures(ctx, budget, input, abortSignal)),
    }),
    ovJourney: tool({
      description: "Volg een rit (journeyId uit ovDepartures of predictOvMovement): haltes met tijden en status, en waar het voertuig nu ongeveer is (tussen welke haltes).",
      inputSchema: jsonSchema<{ journeyId: string }>({ type: "object", properties: { journeyId: { type: "string", description: "Bijvoorbeeld 'NS:31241:2026-10-17' of 'OVAPI:…@ZpBus'" } }, required: ["journeyId"] }),
      execute: (input, { abortSignal }) => safely("ovJourney", () => ovJourney(ctx, budget, input, abortSignal)),
    }),
    predictOvMovement: tool({
      description:
        "Voorspel waar een vossenteam dat met het OV reist (bus/tram/trein) nu is of heen gaat, vanaf een plek en tijd waarop het gezien is: haltes binnen loopafstand, vertrekken die het kon halen, waar die ritten nu zijn, waar het kan zijn uitgestapt, eindpunten, of nog wachten. Max 10 kandidaten met score 0-1, beste eerst, plus aannames.",
      inputSchema: jsonSchema<{ from: string; seenAt: string; maxWalkM?: number; area?: string; modes?: string[] }>({
        type: "object",
        properties: {
          from: { type: "string", description: `Waar het team gezien is. ${POINT_DESCRIPTION}` },
          seenAt: { type: "string", description: "Wanneer (ISO 8601, bv. 2026-10-17T14:05:00+02:00)" },
          maxWalkM: { type: "number", description: "Maximale loopafstand naar een halte in meters (standaard 800, 100-3000)" },
          area: { type: "string", enum: [...AREAS], description: "Deelgebied van het vossenteam: kandidaten daarbinnen scoren hoger" },
          modes: MODES_SCHEMA,
        },
        required: ["from", "seenAt"],
      }),
      execute: (input, { abortSignal }) => safely("predictOvMovement", () => predictOvMovement(ctx, budget, input, abortSignal)),
    }),
  };
}

