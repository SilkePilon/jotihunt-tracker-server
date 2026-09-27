import type { LngLat, PolygonGeometry } from "./types";

/** ORS (or any walking router) could not answer: no key, HTTP error, quota. Callers fall back to estimates. */
export class RoutingUnavailableError extends Error {
  /** Set when the outage cannot resolve itself (e.g. no API key configured) so callers should not retry on a cooldown. */
  readonly permanent: boolean;

  constructor(message: string, options: { permanent?: boolean } = {}) {
    super(message);
    this.name = "RoutingUnavailableError";
    this.permanent = options.permanent ?? false;
  }
}

/** Transitous could not answer. Callers continue with walking only. */
export class TransitUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitUnavailableError";
  }
}

export interface MatrixResult {
  /** durationsS[source][destination] in seconds; null when unreachable */
  durationsS: (number | null)[][];
  distancesM: (number | null)[][];
}

export interface RouteResult {
  line: LngLat[];
  distanceM: number;
  durationS: number;
}

export interface WalkingRouter {
  matrix(sources: LngLat[], destinations: LngLat[]): Promise<MatrixResult>;
  route(a: LngLat, b: LngLat): Promise<RouteResult>;
  /** Walking isochrones keyed by range in minutes */
  isochrones(center: LngLat, rangesMin: number[]): Promise<Record<number, PolygonGeometry>>;
}

export interface TransitPlace {
  name: string;
  lng: number;
  lat: number;
  arrival: Date | null;
  departure: Date | null;
}

export interface TransitLeg {
  /** Transitous mode, e.g. WALK, BUS, TRAM, REGIONAL_RAIL */
  mode: string;
  from: TransitPlace;
  to: TransitPlace;
  /** Line name shown to travellers (e.g. "80", "Intercity") */
  line: string | null;
}

export interface TransitItinerary {
  startTime: Date;
  endTime: Date;
  legs: TransitLeg[];
}

export interface TransitPlanner {
  /** Fastest itinerary departing at departAt, or null when none exists. Throws TransitUnavailableError. */
  plan(from: LngLat, to: LngLat, departAt: Date): Promise<TransitItinerary | null>;
}

export type StopKind = "train" | "tram" | "bus" | "other";

export interface StopInput {
  osmId: number;
  name: string;
  kind: StopKind;
  lng: number;
  lat: number;
}

export type Bbox = [west: number, south: number, east: number, north: number];

export interface StopSource {
  fetchStops(bbox: Bbox): Promise<StopInput[]>;
}
