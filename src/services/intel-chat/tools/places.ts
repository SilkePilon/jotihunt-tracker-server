import { generateText, jsonSchema, tool } from "ai";
import { toGeminiError } from "../../ai/gemini-error";
import { readCapped } from "../../article-media";
import { formatRdAnswer } from "../../rd-answer";
import { loadGroups } from "../data";
import { insideNl, metresBetween, parseCoordinate, type LatLng, type Rd } from "../geo";
import { geocode } from "../pdok.client";
import { pointResult, type PointResult } from "../point";
import { BUDGET_EXHAUSTED, createTurnBudget, safely, spend, ToolInputError, type IntelToolContext, type TurnBudget } from "./context";
import { POINT_DESCRIPTION, readPoint } from "./map";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

// --- findPlaces (OpenStreetMap via Overpass) --------------------------------------------------------------------

export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const OVERPASS_TIMEOUT_MS = 20_000;
const OVERPASS_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_RADIUS_M = 3000;
const MIN_RADIUS_M = 50;
const MAX_RADIUS_M = 15_000;
const MAX_KINDS = 8;
const MAX_PLACES = 25;

type Tags = Record<string, string>;

/** Overpass tag filters per kind, and the same test on an element's tags (to tell which kind a result is) */
const KINDS: Record<string, { filters: string[]; matches: (tags: Tags) => boolean }> = {
  church: { filters: ['["amenity"="place_of_worship"]', '["building"="church"]'], matches: (t) => t.amenity === "place_of_worship" || t.building === "church" },
  windmill: { filters: ['["man_made"="windmill"]'], matches: (t) => t.man_made === "windmill" },
  water_tower: { filters: ['["man_made"="water_tower"]'], matches: (t) => t.man_made === "water_tower" },
  station: { filters: ['["railway"="station"]'], matches: (t) => t.railway === "station" },
  bus_stop: { filters: ['["highway"="bus_stop"]'], matches: (t) => t.highway === "bus_stop" },
  bridge: { filters: ['["man_made"="bridge"]', '["bridge"="yes"]["name"]'], matches: (t) => t.man_made === "bridge" || (t.bridge === "yes" && !!t.name) },
  monument: { filters: ['["historic"]'], matches: (t) => t.historic !== undefined },
  school: { filters: ['["amenity"="school"]'], matches: (t) => t.amenity === "school" },
  castle: { filters: ['["historic"="castle"]'], matches: (t) => t.historic === "castle" },
  tower: { filters: ['["man_made"="tower"]'], matches: (t) => t.man_made === "tower" },
};
const BUS_ROUTE = "bus_route";
/** "any:amenity=pub": only plain tag keys and values (nothing that could break out of the Overpass query) */
const ANY_KIND = /^any:([a-z][a-z0-9_:]{0,40})=([\p{L}\p{N}_\-. ]{1,60})$/iu;

export const PLACE_KINDS = [...Object.keys(KINDS), BUS_ROUTE] as const;

type KindSpec = { kind: string; filters: string[]; matches: (tags: Tags) => boolean };

function readKinds(input: unknown): { specs: KindSpec[]; busRoutes: boolean } {
  const kinds = Array.isArray(input) ? input.map((kind) => String(kind ?? "").trim()) : [];
  if (kinds.length === 0 || kinds.length > MAX_KINDS) throw new ToolInputError("Geef 1 tot 8 soorten plekken");
  const specs: KindSpec[] = [];
  let busRoutes = false;
  for (const kind of new Set(kinds)) {
    const any = ANY_KIND.exec(kind);
    if (kind === BUS_ROUTE) busRoutes = true;
    else if (KINDS[kind]) specs.push({ kind, ...KINDS[kind] });
    else if (any) specs.push({ kind, filters: [`["${any[1]}"="${any[2]}"]`], matches: (tags) => tags[any[1]] === any[2] });
    else throw new ToolInputError(`Onbekende soort plek: ${kind.slice(0, 60)}`);
  }
  return { specs, busRoutes };
}

/** One Overpass QL query: the places with their centre, and (for bus routes) the routes with their member stops near the point */
export function overpassQuery(specs: KindSpec[], busRoutes: boolean, center: LatLng, radiusM: number): string {
  const around = `(around:${radiusM},${center.lat.toFixed(6)},${center.lng.toFixed(6)})`;
  let query = "[out:json][timeout:15];";
  const lines = specs.flatMap((spec) => spec.filters.map((filter) => `nwr${filter}${around};`));
  // No count limit: Overpass would cut by id, not by distance (the 5 MB read cap refuses too many results instead)
  if (lines.length > 0) query += `(${lines.join("")})->.places;.places out center tags;`;
  if (busRoutes) query += `relation["route"="bus"]${around}->.routes;.routes out body center 100;node(r.routes)${around};out skel qt 2000;`;
  return query;
}

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Tags;
  members?: { type: string; ref: number; role?: string }[];
}

async function askOverpass(fetchFn: Fetch, query: string, signal?: AbortSignal): Promise<OverpassElement[]> {
  const timeout = AbortSignal.timeout(OVERPASS_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchFn(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": "jotihunt-tracker (Intel chat)" },
      body: `data=${encodeURIComponent(query)}`,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    throw new ToolInputError("Overpass (OpenStreetMap) niet bereikbaar");
  }
  if (response.status === 429 || response.status === 504) throw new ToolInputError(`Overpass (OpenStreetMap) is druk (HTTP ${response.status}); probeer het later`);
  if (!response.ok) throw new ToolInputError(`Overpass (OpenStreetMap) gaf HTTP ${response.status}`);
  const bytes = await readCapped(response, OVERPASS_MAX_BYTES).catch(() => {
    throw new ToolInputError("Overpass (OpenStreetMap) niet bereikbaar");
  });
  if (!bytes) throw new ToolInputError("Te veel resultaten; kies een kleinere straal of minder soorten");
  let body: { elements?: unknown; remark?: unknown };
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as typeof body;
  } catch {
    throw new ToolInputError("Overpass gaf geen geldig antwoord");
  }
  if (typeof body.remark === "string" && /runtime error/i.test(body.remark)) throw new ToolInputError("De Overpass-zoekopdracht duurde te lang; kies een kleinere straal of minder soorten");
  return Array.isArray(body.elements) ? (body.elements as OverpassElement[]).filter((element) => element && typeof element === "object") : [];
}

export interface Place {
  name: string | null;
  kind: string;
  latLng: LatLng;
  rdText: string;
  distanceM: number;
  detail?: string;
}

const positionOf = (element: OverpassElement): LatLng | null =>
  typeof element.lat === "number" && typeof element.lon === "number" ? { lat: element.lat, lng: element.lon } : element.center ? { lat: element.center.lat, lng: element.center.lon } : null;

const busDetail = (tags: Tags) => (tags.ref ? `lijn ${tags.ref}${tags.from && tags.to ? `: ${tags.from} → ${tags.to}` : ""}` : (tags.name ?? "buslijn"));

/** OSM places of the asked kinds within the radius, nearest first (max 25) */
export async function findPlaces(ctx: IntelToolContext, budget: TurnBudget, input: { near: string; radiusM?: number; kinds: string[] }, signal?: AbortSignal): Promise<{ places: Place[] }> {
  const { specs, busRoutes } = readKinds(input.kinds);
  const radiusM = Math.round(Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, Number(input.radiusM) || DEFAULT_RADIUS_M)));
  const nearText = String(input.near ?? "").trim();
  if (!nearText) throw new ToolInputError("Geef bij near een punt of plaatsnaam");
  let center = parseCoordinate(nearText)?.latLng;
  if (!center) {
    const hit = (await geocode(nearText, { fetch: ctx.fetch, signal }))[0];
    if (!hit) throw new ToolInputError(`Plaats "${nearText.slice(0, 60)}" niet gevonden`);
    center = hit.latLng;
  }
  if (!spend(budget, "findPlaces")) throw new ToolInputError(BUDGET_EXHAUSTED);

  const elements = await askOverpass(ctx.fetch ?? fetch, overpassQuery(specs, busRoutes, center, radiusM), signal);
  const nodes = new Map(elements.filter((element) => element.type === "node").flatMap((element) => (positionOf(element) ? [[element.id, positionOf(element)!] as const] : [])));
  const places: Place[] = [];
  const add = (kind: string, tags: Tags, latLng: LatLng, detail?: string) => {
    const distanceM = metresBetween(center, latLng);
    if (distanceM > radiusM) return;
    places.push({
      name: tags.name ?? null,
      kind,
      latLng: { lat: Number(latLng.lat.toFixed(6)), lng: Number(latLng.lng.toFixed(6)) },
      rdText: formatRdAnswer(latLng.lng, latLng.lat),
      distanceM,
      ...(detail ? { detail } : {}),
    });
  };
  for (const element of elements) {
    const tags = element.tags;
    if (!tags) continue;
    if (busRoutes && element.type === "relation" && tags.route === "bus") {
      // The route's stop nearest to the point, else the route's centre
      const stops = (element.members ?? []).flatMap((member) => (member.type === "node" && nodes.has(member.ref) ? [nodes.get(member.ref)!] : []));
      const nearest = stops.sort((a, b) => metresBetween(center, a) - metresBetween(center, b))[0] ?? positionOf(element);
      if (nearest) add(BUS_ROUTE, tags, nearest, busDetail(tags));
      continue;
    }
    const spec = specs.find((candidate) => candidate.matches(tags));
    const position = positionOf(element);
    if (spec && position) add(spec.kind, tags, position);
  }
  return { places: places.sort((a, b) => a.distanceM - b.distanceM).slice(0, MAX_PLACES) };
}

// --- lookAtPoint (PDOK aerial photo + Gemini vision) ------------------------------------------------------------

const AERIAL_WMS_URL = "https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0";
const AERIAL_SIZE_PX = 768;
const DEFAULT_ZOOM_M = 150;
const MIN_ZOOM_M = 50;
const MAX_ZOOM_M = 1000;
const AERIAL_TIMEOUT_MS = 15_000;
const AERIAL_MAX_BYTES = 3 * 1024 * 1024;
const VISION_TIMEOUT_MS = 60_000;
const MAX_DESCRIPTION = 2000;

/** PDOK WMS GetMap URL of the current high-resolution aerial photo: an RD box of 2 × `halfSizeM` around the point, 768 × 768 JPEG */
export function aerialPhotoUrl(rd: Rd, halfSizeM: number): string {
  const x = Math.round(rd.x);
  const y = Math.round(rd.y);
  const params = new URLSearchParams({
    SERVICE: "WMS",
    VERSION: "1.3.0",
    REQUEST: "GetMap",
    LAYERS: "Actueel_orthoHR",
    STYLES: "",
    CRS: "EPSG:28992",
    BBOX: [x - halfSizeM, y - halfSizeM, x + halfSizeM, y + halfSizeM].join(","),
    WIDTH: String(AERIAL_SIZE_PX),
    HEIGHT: String(AERIAL_SIZE_PX),
    FORMAT: "image/jpeg",
  });
  return `${AERIAL_WMS_URL}?${params.toString()}`;
}

async function downloadPhoto(fetchFn: Fetch, url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const timeout = AbortSignal.timeout(AERIAL_TIMEOUT_MS);
  try {
    const response = await fetchFn(url, { headers: { Accept: "image/jpeg" }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) throw new ToolInputError(`PDOK-luchtfoto gaf HTTP ${response.status}`);
    if (!(response.headers.get("content-type") ?? "").startsWith("image/")) throw new ToolInputError("PDOK gaf geen luchtfoto");
    if (Number(response.headers.get("content-length")) > AERIAL_MAX_BYTES) throw new ToolInputError("Luchtfoto te groot");
    const data = await readCapped(response, AERIAL_MAX_BYTES);
    if (!data) throw new ToolInputError("Luchtfoto te groot");
    return data;
  } catch (error) {
    if (error instanceof ToolInputError) throw error;
    throw new ToolInputError("PDOK-luchtfoto niet bereikbaar");
  }
}

const visionPrompt = (sizeM: number) =>
  `Dit is een luchtfoto (noorden boven, ongeveer ${sizeM} bij ${sizeM} meter) rond een punt in Nederland; het punt ligt precies in het midden. ` +
  "Beschrijf kort in het Nederlands (hooguit 6 zinnen) wat helpt bij het zoeken naar een vossenteam van de Jotihunt: herkenningspunten, gebouwen (kerk, molen, school, boerderij), " +
  "wegen en paden, water, bos en velden, parkeerplaatsen en ingangen. Zeg waar iets ligt ten opzichte van het midden (noord, oost, zuid, west). Noem alleen wat je echt ziet.";

export interface LookAtPointResult {
  description: string;
  imageUrl: string;
  point: PointResult;
}

/** The aerial photo around a point, described by Gemini */
export async function lookAtPoint(ctx: IntelToolContext, budget: TurnBudget, input: { point: string; zoomM?: number }, signal?: AbortSignal): Promise<LookAtPointResult> {
  const parsed = readPoint(input.point);
  if (!insideNl(parsed.latLng)) throw new ToolInputError("Luchtfoto's zijn er alleen voor Nederland");
  const zoomM = Math.round(Math.min(MAX_ZOOM_M, Math.max(MIN_ZOOM_M, Number(input.zoomM) || DEFAULT_ZOOM_M)));
  if (!spend(budget, "lookAtPoint")) throw new ToolInputError(BUDGET_EXHAUSTED);
  const imageUrl = aerialPhotoUrl(parsed.rd, zoomM);
  const photo = await downloadPhoto(ctx.fetch ?? fetch, imageUrl, signal);
  let description: string;
  try {
    const result = await generateText({
      model: ctx.toolModel,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: visionPrompt(zoomM * 2) },
            { type: "file", data: photo, mediaType: "image/jpeg" },
          ],
        },
      ],
      maxRetries: 0,
      timeout: VISION_TIMEOUT_MS,
      abortSignal: signal,
    });
    description = result.text.trim().slice(0, MAX_DESCRIPTION);
  } catch (error) {
    throw toGeminiError(error);
  }
  if (!description) throw new ToolInputError("Gemini gaf geen beschrijving van de luchtfoto");
  return { description, imageUrl, point: pointResult(parsed, "Luchtfoto", await loadGroups()) };
}

export function placesTools(turn: IntelToolContext) {
  const ctx: IntelToolContext = { ...turn, budget: turn.budget ?? createTurnBudget() };
  const budget = ctx.budget!;
  return {
    findPlaces: tool({
      description:
        "Zoek plekken uit OpenStreetMap rond een punt of plaats (max 25, dichtstbijzijnde eerst): kerken, molens, watertorens, stations, bushaltes, buslijnen (met lijnnummer en van → naar), bruggen, monumenten, scholen, kastelen, torens, of any:<tag>=<waarde>. Max 4 keer per vraag.",
      inputSchema: jsonSchema<{ near: string; radiusM?: number; kinds: string[] }>({
        type: "object",
        properties: {
          near: { type: "string", description: `${POINT_DESCRIPTION}, of een plaatsnaam/adres` },
          radiusM: { type: "number", description: "Straal in meters (standaard 3000, max 15000)" },
          kinds: { type: "array", items: { type: "string" }, description: `1-8 soorten: ${PLACE_KINDS.join(", ")} of any:<osm-tag>=<waarde> (bv. any:amenity=pub)` },
        },
        required: ["near", "kinds"],
      }),
      execute: (input, { abortSignal }) => safely("findPlaces", () => findPlaces(ctx, budget, input, abortSignal)),
    }),
    lookAtPoint: tool({
      description:
        "Bekijk de actuele luchtfoto (PDOK) rond een punt in Nederland en krijg een korte beschrijving: gebouwen, wegen, water, velden, parkeerplaatsen, ingangen. De gebruiker ziet de foto ook. Max 3 keer per vraag.",
      inputSchema: jsonSchema<{ point: string; zoomM?: number }>({
        type: "object",
        properties: { point: { type: "string", description: POINT_DESCRIPTION }, zoomM: { type: "number", description: "Halve breedte van de foto in meters (standaard 150, 50-1000)" } },
        required: ["point"],
      }),
      execute: (input, { abortSignal }) => safely("lookAtPoint", () => lookAtPoint(ctx, budget, input, abortSignal)),
    }),
  };
}
