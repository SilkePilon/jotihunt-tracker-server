import { OVERPASS_QUERY, type OverpassElement } from "./fastfood.helpers";
import { errorText } from "../utils/error-text";

export const OVERPASS_ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const USER_AGENT = "jotihunt-tracker (fastfood layer)";

/** No Overpass endpoint answered something usable. */
export class FastfoodUpstreamError extends Error {}

export interface FastfoodApi {
  /** Every McDonald's, KFC and Burger King in the Netherlands. */
  fetchElements(): Promise<OverpassElement[]>;
}

/** OpenStreetMap through the public Overpass API (ODbL); tries the endpoints in order. */
export class OverpassClient implements FastfoodApi {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 120_000,
    private readonly endpoints = OVERPASS_ENDPOINTS,
  ) {}

  async fetchElements(): Promise<OverpassElement[]> {
    const failures: string[] = [];
    for (const endpoint of this.endpoints) {
      try {
        return await this.fetchFrom(endpoint);
      } catch (error) {
        failures.push(`${endpoint}: ${errorText(error)}`);
      }
    }
    throw new FastfoodUpstreamError(`Overpass not reachable (${failures.join("; ")})`);
  }

  private async fetchFrom(endpoint: string): Promise<OverpassElement[]> {
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
      body: new URLSearchParams({ data: OVERPASS_QUERY }).toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`answered ${response.status}`);
    }
    const body = (await response.json()) as { elements?: unknown };
    if (!Array.isArray(body.elements)) throw new Error("answered no elements");
    return body.elements as OverpassElement[];
  }
}
