import { ToolInputError } from "./tools/context";
import type { LatLng } from "./geo";

/** PDOK Locatieserver (Dutch addresses, streets, places, postcodes; no key, NL only) */
export const PDOK_BASE_URL = "https://api.pdok.nl/bzk/locatieserver/search/v3_1";
export const PDOK_TIMEOUT_MS = 10_000;
const ROWS = 5;
/** Asked from PDOK for a free search, so a hit in the named town further down can still be ranked up */
const SEARCH_ROWS = 10;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface GeocodeHit {
  name: string;
  type: string;
  latLng: LatLng;
}

export interface ReverseHit {
  name: string;
  type: string;
  distanceM: number;
}

async function pdokDocs(fetchFn: Fetch, url: string, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
  let response: Response;
  try {
    response = await fetchFn(url, { headers: { Accept: "application/json" }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(PDOK_TIMEOUT_MS)]) : AbortSignal.timeout(PDOK_TIMEOUT_MS) });
  } catch {
    throw new ToolInputError("PDOK niet bereikbaar");
  }
  if (!response.ok) throw new ToolInputError(`PDOK gaf HTTP ${response.status}`);
  const body = (await response.json().catch(() => null)) as { response?: { docs?: unknown } } | null;
  const docs = body?.response?.docs;
  return Array.isArray(docs) ? docs.filter((doc): doc is Record<string, unknown> => typeof doc === "object" && doc !== null) : [];
}

/** "POINT(5.87 51.95)" → { lat, lng } */
export function parseWktPoint(value: unknown): LatLng | null {
  const match = typeof value === "string" ? /^POINT\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)$/.exec(value) : null;
  return match ? { lng: Number(match[1]), lat: Number(match[2]) } : null;
}

const normalise = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Higher for a doc in a town the query names (its woonplaats over its gemeente), plus more for an address/street there when the query asks more than the town */
function townScore(query: string, doc: Record<string, unknown>): number {
  const padded = ` ${query} `;
  const named = (field: unknown) => {
    const town = typeof field === "string" ? normalise(field) : "";
    return town && padded.includes(` ${town} `) ? town : null;
  };
  const town = named(doc.woonplaatsnaam);
  const municipality = town ? null : named(doc.gemeentenaam);
  const matched = town ?? municipality;
  if (!matched) return 0;
  const rest = padded.replace(` ${matched} `, " ").trim();
  return (town ? 2 : 1) + (rest && (doc.type === "adres" || doc.type === "weg") ? 2 : 0);
}

/** Up to 5 places for a free-text query (address, street, place, postcode); results in a town named in the query first */
export async function geocode(query: string, { fetch: fetchFn = fetch, signal }: { fetch?: Fetch; signal?: AbortSignal } = {}): Promise<GeocodeHit[]> {
  const q = String(query ?? "").trim();
  if (!q || q.length > 200) throw new ToolInputError("Zoekterm moet 1 tot 200 tekens zijn");
  const docs = await pdokDocs(fetchFn, `${PDOK_BASE_URL}/free?q=${encodeURIComponent(q)}&rows=${SEARCH_ROWS}&fl=weergavenaam,type,centroide_ll,woonplaatsnaam,gemeentenaam`, signal);
  const wanted = normalise(q);
  return docs
    .map((doc, index) => ({ doc, index, score: townScore(wanted, doc) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .flatMap(({ doc }) => {
      const latLng = parseWktPoint(doc.centroide_ll);
      return latLng && typeof doc.weergavenaam === "string" ? [{ name: doc.weergavenaam, type: String(doc.type ?? ""), latLng }] : [];
    })
    .slice(0, ROWS);
}

/** Up to 5 addresses nearest to a point, nearest first */
export async function reverseGeocode(point: LatLng, { fetch: fetchFn = fetch, signal }: { fetch?: Fetch; signal?: AbortSignal } = {}): Promise<ReverseHit[]> {
  const docs = await pdokDocs(fetchFn, `${PDOK_BASE_URL}/reverse?lat=${point.lat.toFixed(6)}&lon=${point.lng.toFixed(6)}&rows=${ROWS}`, signal);
  return docs.flatMap((doc) => (typeof doc.weergavenaam === "string" ? [{ name: doc.weergavenaam, type: String(doc.type ?? ""), distanceM: Math.round(Number(doc.afstand) || 0) }] : []));
}
