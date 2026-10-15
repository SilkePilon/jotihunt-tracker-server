import { jsonSchema, tool } from "ai";
import { AREAS, knownAreaName } from "../../../constants/areas";
import { loadGroups, loadSolvedHintPoints, loadTrackers } from "../data";
import { formatCoordinate, groupsWithin, insideNl, parseCoordinate, type ParsedCoordinate } from "../geo";
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
  };
}
