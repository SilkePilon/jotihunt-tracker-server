import { ToolInputError } from "./tools/context";
import type { LatLng } from "./geo";

/** PDOK Locatieserver (Dutch addresses, streets, places, postcodes; no key, NL only) */
export const PDOK_BASE_URL = "https://api.pdok.nl/bzk/locatieserver/search/v3_1";
export const PDOK_TIMEOUT_MS = 10_000;
const ROWS = 5;

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

/** Up to 5 places for a free-text query (address, street, place, postcode) */
export async function geocode(query: string, { fetch: fetchFn = fetch, signal }: { fetch?: Fetch; signal?: AbortSignal } = {}): Promise<GeocodeHit[]> {
  const q = String(query ?? "").trim();
  if (!q || q.length > 200) throw new ToolInputError("Zoekterm moet 1 tot 200 tekens zijn");
  const docs = await pdokDocs(fetchFn, `${PDOK_BASE_URL}/free?q=${encodeURIComponent(q)}&rows=${ROWS}&fl=weergavenaam,type,centroide_ll`, signal);
  return docs.flatMap((doc) => {
    const latLng = parseWktPoint(doc.centroide_ll);
    return latLng && typeof doc.weergavenaam === "string" ? [{ name: doc.weergavenaam, type: String(doc.type ?? ""), latLng }] : [];
  });
}

/** Up to 5 addresses nearest to a point, nearest first */
export async function reverseGeocode(point: LatLng, { fetch: fetchFn = fetch, signal }: { fetch?: Fetch; signal?: AbortSignal } = {}): Promise<ReverseHit[]> {
  const docs = await pdokDocs(fetchFn, `${PDOK_BASE_URL}/reverse?lat=${point.lat.toFixed(6)}&lon=${point.lng.toFixed(6)}&rows=${ROWS}`, signal);
  return docs.flatMap((doc) => (typeof doc.weergavenaam === "string" ? [{ name: doc.weergavenaam, type: String(doc.type ?? ""), distanceM: Math.round(Number(doc.afstand) || 0) }] : []));
}
