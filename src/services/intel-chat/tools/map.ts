import { jsonSchema, tool } from "ai";
import { AREAS, knownAreaName } from "../../../constants/areas";
import { loadGroups, loadSolvedHintPoints, loadTrackers } from "../data";
import { straightLineSeconds } from "../../prediction/straight-line.router";
import { bearingBetween, coordinateAt, formatCoordinate, groupsWithin, insideNl, metresBetween, parseCoordinate, projectFrom, type ParsedCoordinate } from "../geo";
import { geocode, reverseGeocode } from "../pdok.client";
import { checkPointResult } from "../point";
import { safely, ToolInputError, type IntelToolContext } from "./context";

/** Description of a `point` argument, shared by every tool that takes one */
export const POINT_DESCRIPTION = 'Coördinaat als tekst: RD ("1884 4407" of "188362 440722"), decimaal ("51.95392, 5.87252") of graden-minuten ("N 51° 57.235 E 5° 52.351")';

/** The point, or a ToolInputError the model can act on */
export function readPoint(input: string, name = "point"): ParsedCoordinate {
  const parsed = parseCoordinate(String(input ?? ""));
  if (!parsed) throw new ToolInputError(`Kon geen coördinaat lezen uit ${name} "${String(input ?? "").slice(0, 60)}"`);
  return parsed;
}

/** A known area (lowercase), undefined when not given; ToolInputError when unknown */
export function readArea(input: string | undefined): string | undefined {
  if (input === undefined || input === null || input === "") return undefined;
  const area = knownAreaName(input);
  if (!area) throw new ToolInputError(`Onbekend deelgebied: ${input}`);
  return area;
}

const MIN_RADIUS_M = 50;
const MAX_RADIUS_M = 20_000;
const MAX_NEARBY = 25;
const MAX_PROJECT_M = 100_000;

/** Straight line, bearing and (optionally) walking time between two points */
export async function measure(ctx: IntelToolContext, fromText: string, toText: string, walking: boolean) {
  const from = readPoint(fromText, "from").latLng;
  const to = readPoint(toText, "to").latLng;
  const result: { distanceM: number; bearingDeg: number; walkMinutes?: number; walkEstimate?: boolean } = { distanceM: metresBetween(from, to), bearingDeg: bearingBetween(from, to) };
  if (!walking) return result;
  if (ctx.walkMinutes) {
    const { minutes, estimate } = await ctx.walkMinutes([from.lng, from.lat], [[to.lng, to.lat]]);
    return { ...result, walkMinutes: minutes[0], walkEstimate: estimate };
  }
  return { ...result, walkMinutes: Math.round(straightLineSeconds([from.lng, from.lat], [to.lng, to.lat]) / 60), walkEstimate: true };
}

/** The point at a distance and compass bearing from another (coördinatenprojectie) */
export function project(fromText: string, bearing: number, metres: number) {
  const from = readPoint(fromText, "from").latLng;
  if (!Number.isFinite(bearing)) throw new ToolInputError("bearingDeg moet een getal zijn");
  if (!Number.isFinite(metres) || metres < 0 || metres > MAX_PROJECT_M) throw new ToolInputError("distanceM moet tussen 0 en 100000 liggen");
  const target = coordinateAt(projectFrom(from, ((bearing % 360) + 360) % 360, metres));
  return { latLng: target.latLng, rd: { x: Math.round(target.rd.x), y: Math.round(target.rd.y) }, formatted: formatCoordinate(target), insideNl: insideNl(target.latLng) };
}
export function mapTools(ctx: IntelToolContext) {
  return {
    convertCoordinates: tool({
      description: "Zet een coördinaat om (RD in 4/5/6 cijfers, decimale graden of graden-minuten-seconden). Geeft RD, lat/lng en alle notaties, waaronder het 8-cijferige Jotihunt-antwoord (rd8).",
      inputSchema: jsonSchema<{ input: string }>({ type: "object", properties: { input: { type: "string", description: "De coördinaat zoals gevonden" } }, required: ["input"] }),
      execute: ({ input }) =>
        safely("convertCoordinates", async () => {
          const parsed = readPoint(input, "input");
          return { kind: parsed.kind, rd: { x: Math.round(parsed.rd.x), y: Math.round(parsed.rd.y) }, latLng: parsed.latLng, formatted: formatCoordinate(parsed), insideNl: insideNl(parsed.latLng) };
        }),
    }),
    checkPoint: tool({
      description:
        "Controleer een kandidaat-punt: geschat deelgebied (method 'hull' = zeker, anders een schatting), de 5 dichtstbijzijnde groepen, of het in Nederland ligt, afstand tot de andere opgeloste hintpunten van dat deelgebied en onze dichtstbijzijnde tracker. Altijd gebruiken voor je een punt voorstelt.",
      inputSchema: jsonSchema<{ point: string; area?: string }>({
        type: "object",
        properties: { point: { type: "string", description: POINT_DESCRIPTION }, area: { type: "string", enum: [...AREAS], description: "Deelgebied waar het punt bij hoort, als je dat weet" } },
        required: ["point"],
      }),
      execute: ({ point, area }) =>
        safely("checkPoint", async () => {
          const parsed = readPoint(point);
          const key = readArea(area);
          const now = ctx.now();
          const [groups, hintPoints, trackers] = await Promise.all([loadGroups(), loadSolvedHintPoints(), loadTrackers(now)]);
          return checkPointResult(parsed, { groups, hintPoints, trackers, area: key, articleId: ctx.articleId, now });
        }),
    }),
    nearbyGroups: tool({
      description: "Scoutinggroepen binnen een straal rond een punt, dichtstbijzijnde eerst (max 25).",
      inputSchema: jsonSchema<{ point: string; radiusM: number }>({
        type: "object",
        properties: { point: { type: "string", description: POINT_DESCRIPTION }, radiusM: { type: "number", description: "Straal in meters (50-20000)" } },
        required: ["point", "radiusM"],
      }),
      execute: ({ point, radiusM }) =>
        safely("nearbyGroups", async () => {
          const parsed = readPoint(point);
          const radius = Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, Number(radiusM) || 0));
          return { groups: groupsWithin(parsed.latLng, await loadGroups(), radius).slice(0, MAX_NEARBY) };
        }),
    }),
    distance: tool({
      description: "Afstand in meters en kompasrichting (0-360, 0 = noord) tussen twee punten; met walking ook de looptijd in minuten (route te voet, of een schatting).",
      inputSchema: jsonSchema<{ from: string; to: string; walking?: boolean }>({
        type: "object",
        properties: { from: { type: "string", description: POINT_DESCRIPTION }, to: { type: "string", description: POINT_DESCRIPTION }, walking: { type: "boolean", description: "Ook looptijd berekenen" } },
        required: ["from", "to"],
      }),
      execute: ({ from, to, walking }) => safely("distance", () => measure(ctx, from, to, walking === true)),
    }),
    projectPoint: tool({
      description: "Bereken het punt op een afstand en kompasrichting vanaf een ander punt (coördinatenprojectie, bv. '7,31 km op 262 graden vanaf HQ').",
      inputSchema: jsonSchema<{ from: string; bearingDeg: number; distanceM: number }>({
        type: "object",
        properties: {
          from: { type: "string", description: POINT_DESCRIPTION },
          bearingDeg: { type: "number", description: "Kompasrichting in graden, 0 = noord, 90 = oost" },
          distanceM: { type: "number", description: "Afstand in meters (0-100000)" },
        },
        required: ["from", "bearingDeg", "distanceM"],
      }),
      execute: ({ from, bearingDeg, distanceM }) => safely("projectPoint", async () => project(from, Number(bearingDeg), Number(distanceM))),
    }),
    geocode: tool({
      description: "Zoek een adres, straat, plaats of postcode in Nederland (PDOK). Geeft max 5 treffers met coördinaten.",
      inputSchema: jsonSchema<{ query: string }>({ type: "object", properties: { query: { type: "string", description: "Bijvoorbeeld 'Stikkerstraat 10 Arnhem' of '6842CW'" } }, required: ["query"] }),
      execute: ({ query }, { abortSignal }) =>
        safely("geocode", async () => ({
          results: (await geocode(query, { fetch: ctx.fetch, signal: abortSignal })).map((hit) => ({ ...hit, rdText: formatCoordinate(coordinateAt(hit.latLng)).rd8 })),
        })),
    }),
    reverseGeocode: tool({
      description: "De dichtstbijzijnde adressen bij een punt in Nederland (PDOK), met afstand in meters.",
      inputSchema: jsonSchema<{ point: string }>({ type: "object", properties: { point: { type: "string", description: POINT_DESCRIPTION } }, required: ["point"] }),
      execute: ({ point }, { abortSignal }) => safely("reverseGeocode", async () => ({ results: await reverseGeocode(readPoint(point).latLng, { fetch: ctx.fetch, signal: abortSignal }) })),
    }),
  };
}
