import type { Bounds, RawBuildingPart } from "./buildings.helpers";
import { errorText } from "../utils/error-text";

export const WFS_URL = "https://data.3dbag.nl/api/BAG3D/wfs";
export const PAGE_SIZE = 10_000;
/** A z15 tile in a city centre has ~5–20k parts; more than this means something is wrong */
const MAX_PARTS = 200_000;

/** 3DBAG could not be reached or answered something unusable; never cached. */
export class BuildingsUpstreamError extends Error {}

export interface BuildingsApi {
  /** All lod22 roof parts in `bounds` (lon/lat). */
  fetchParts(bounds: Bounds): Promise<RawBuildingPart[]>;
}

/** The 3DBAG WFS (TU Delft + 3DGI, CC BY 4.0). */
export class BagWfsClient implements BuildingsApi {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 60_000,
  ) {}

  async fetchParts(bounds: Bounds): Promise<RawBuildingPart[]> {
    const parts: RawBuildingPart[] = [];
    for (let start = 0; start < MAX_PARTS; start += PAGE_SIZE) {
      const page = await this.fetchPage(bounds, start);
      parts.push(...page);
      if (page.length < PAGE_SIZE) return parts;
    }
    throw new BuildingsUpstreamError(`More than ${MAX_PARTS} building parts in one tile`);
  }

  private async fetchPage({ west, south, east, north }: Bounds, startIndex: number): Promise<RawBuildingPart[]> {
    const url = new URL(WFS_URL);
    const params = {
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeNames: "BAG3D:lod22",
      srsName: "EPSG:4326",
      outputFormat: "application/json",
      // Without geom the WFS leaves the geometry out
      propertyName: "geom,b3_h_70p,b3_h_maaiveld",
      // A stable order, so the pages don't overlap or skip parts
      sortBy: "fid",
      count: String(PAGE_SIZE),
      startIndex: String(startIndex),
      // Plain EPSG:4326 takes lon,lat order on this GeoServer (checked live)
      bbox: `${west},${south},${east},${north},EPSG:4326`,
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new BuildingsUpstreamError(`3DBAG not reachable: ${errorText(error)}`);
    }
    if (!response.ok) {
      // Free the connection; the error body isn't needed
      await response.body?.cancel();
      throw new BuildingsUpstreamError(`3DBAG answered ${response.status}`);
    }
    let body: { features?: unknown };
    try {
      body = (await response.json()) as { features?: unknown };
    } catch {
      throw new BuildingsUpstreamError("3DBAG answered no JSON");
    }
    if (!Array.isArray(body.features)) throw new BuildingsUpstreamError("3DBAG answered no feature collection");
    return body.features as RawBuildingPart[];
  }
}
