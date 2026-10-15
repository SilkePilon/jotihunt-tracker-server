import { describe, expect, test } from "bun:test";
import { BagWfsClient, BuildingsUpstreamError, PAGE_SIZE } from "./buildings.client";

const BOUNDS = { west: 5.9, south: 51.98, east: 5.91, north: 51.99 };
const part = (i: number) => ({ type: "Feature", geometry: null, properties: { fid: i, b3_h_70p: 10, b3_h_maaiveld: 1 } });

function fakeFetch(pages: unknown[][], status = 200) {
  const urls: URL[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    const page = pages[Number(url.searchParams.get("startIndex")) / PAGE_SIZE] ?? [];
    return new Response(JSON.stringify({ type: "FeatureCollection", features: page }), { status });
  }) as typeof fetch;
  return { impl, urls };
}

describe("BagWfsClient", () => {
  test("asks lod22 roof parts with geometry and heights in the bbox (lon,lat order)", async () => {
    const { impl, urls } = fakeFetch([[part(1)]]);
    const parts = await new BagWfsClient(impl).fetchParts(BOUNDS);
    expect(parts).toHaveLength(1);
    const q = urls[0].searchParams;
    expect(urls[0].origin + urls[0].pathname).toBe("https://data.3dbag.nl/api/BAG3D/wfs");
    expect(q.get("typeNames")).toBe("BAG3D:lod22");
    expect(q.get("srsName")).toBe("EPSG:4326");
    expect(q.get("outputFormat")).toBe("application/json");
    expect(q.get("propertyName")).toBe("geom,b3_h_70p,b3_h_maaiveld");
    expect(q.get("sortBy")).toBe("fid");
    expect(q.get("count")).toBe(String(PAGE_SIZE));
    expect(q.get("startIndex")).toBe("0");
    expect(q.get("bbox")).toBe("5.9,51.98,5.91,51.99,EPSG:4326");
  });

  test("pages until a short page", async () => {
    const full = Array.from({ length: PAGE_SIZE }, (_, i) => part(i));
    const { impl, urls } = fakeFetch([full, [part(PAGE_SIZE)]]);
    const parts = await new BagWfsClient(impl).fetchParts(BOUNDS);
    expect(parts).toHaveLength(PAGE_SIZE + 1);
    expect(urls.map((url) => url.searchParams.get("startIndex"))).toEqual(["0", String(PAGE_SIZE)]);
  });

  test("HTTP error: BuildingsUpstreamError", async () => {
    const { impl } = fakeFetch([[]], 503);
    await expect(new BagWfsClient(impl).fetchParts(BOUNDS)).rejects.toBeInstanceOf(BuildingsUpstreamError);
  });

  test("network error: BuildingsUpstreamError", async () => {
    const impl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(new BagWfsClient(impl).fetchParts(BOUNDS)).rejects.toBeInstanceOf(BuildingsUpstreamError);
  });

  test("not a feature collection: BuildingsUpstreamError", async () => {
    const impl = (async () => new Response("<html>oops</html>", { status: 200 })) as unknown as typeof fetch;
    await expect(new BagWfsClient(impl).fetchParts(BOUNDS)).rejects.toBeInstanceOf(BuildingsUpstreamError);
  });
});
