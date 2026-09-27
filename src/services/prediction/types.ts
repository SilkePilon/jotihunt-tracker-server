export type LngLat = [number, number];

export interface PolygonGeometry {
  type: "Polygon";
  coordinates: number[][][];
}

export type ObservationKind = "hint" | "hunt" | "spot";

export interface Observation {
  time: Date;
  lng: number;
  lat: number;
  kind: ObservationKind;
}

export interface GroupRef {
  teamApiId: number;
  name: string;
  lng: number;
  lat: number;
}

export interface Weights {
  wTime: number;
  wHeading: number;
  wTour: number;
  wCluster: number;
}

export interface TermValues {
  time: number;
  heading: number;
  tour: number;
  cluster: number;
}

export interface ModelParams {
  speedFactor: number;
  dwellMinutes: number;
  weights: Weights;
}

export const DEFAULT_PARAMS: ModelParams = {
  speedFactor: 1,
  dwellMinutes: 15,
  weights: { wTime: 1, wHeading: 0.5, wTour: 0.7, wCluster: 0.3 },
};
