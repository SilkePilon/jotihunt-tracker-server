export type LngLat = [number, number];

export type ObservationKind = "hint" | "hunt" | "spot";

export interface GroupRef {
  teamApiId: number;
  name: string;
  lng: number;
  lat: number;
}
