import { createHash } from "node:crypto";
import { Area } from "../../models/area.model";
import { GroupVisit, VisitSource } from "../../models/group-visit.model";
import { Marker } from "../../models/marker.model";
import { Prediction } from "../../models/prediction.model";
import { Team } from "../../models/team.model";
import type { GroupRef, LngLat, ObservationKind } from "./types";
import type { WalkMinutes } from "./walking";

export interface TrailPoint {
  id: string;
  time: Date;
  kind: ObservationKind;
  lng: number;
  lat: number;
}

export interface ManualVisitFact {
  teamApiId: number;
  state: "visited" | "not_visited";
}

export interface AreaInputs {
  area: string;
  status: string;
  round: number;
  /** Groups the stored prediction already counted as visited (used to guard the round advance) */
  previousVisited: number[];
  groups: GroupRef[];
  trail: TrailPoint[];
  manualVisits: ManualVisitFact[];
}

export interface GroupFact extends GroupRef {
  walkMinutes: number;
}

export interface AreaFacts extends Omit<AreaInputs, "groups"> {
  now: Date;
  groups: GroupFact[];
  /** Walk minutes are straight-line estimates (ORS unavailable) */
  estimate: boolean;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lowercase names of all known areas (from the Jotihunt areas and the groups' areas). */
export async function listAreaNames(): Promise<string[]> {
  const [areaNames, teamAreas] = await Promise.all([Area.distinct("name"), Team.distinct("area")]);
  const names = [...areaNames, ...teamAreas].filter((name): name is string => typeof name === "string" && name.trim().length > 0);
  return [...new Set(names.map((name) => name.toLowerCase()))].sort();
}

/** Everything the prediction needs from the database for one (lowercase) area. */
export async function loadAreaInputs(area: string): Promise<AreaInputs> {
  const nameRegex = new RegExp(`^${escapeRegExp(area)}$`, "i");
  const [areaDoc, teams, markers, stored] = await Promise.all([
    Area.findOne({ name: nameRegex }).lean(),
    Team.find({ area: nameRegex }).lean(),
    Marker.find({ area: nameRegex }).sort({ time: 1 }).lean(),
    Prediction.findOne({ area }, { round: 1, visitedTeamApiIds: 1 }).lean(),
  ]);
  const round = stored?.round ?? 1;
  const visits = await GroupVisit.find({ area, round, source: VisitSource.Manual }).sort({ teamApiId: 1 }).lean();
  return {
    area,
    status: areaDoc?.status ?? "unknown",
    round,
    previousVisited: stored?.visitedTeamApiIds ?? [],
    groups: teams
      .map((team) => ({ teamApiId: team.apiId, name: team.name, lng: team.location.coordinates[0], lat: team.location.coordinates[1] }))
      .sort((a, b) => a.teamApiId - b.teamApiId),
    trail: markers.map((marker) => ({
      id: String(marker._id),
      time: marker.time,
      kind: marker.type as ObservationKind,
      lng: marker.location.coordinates[0],
      lat: marker.location.coordinates[1],
    })),
    manualVisits: visits.map((visit) => ({ teamApiId: visit.teamApiId, state: visit.state as ManualVisitFact["state"] })),
  };
}

/** Fingerprint of the inputs: status, groups, every marker and the manual visits. */
export function signatureOf(inputs: AreaInputs): string {
  const parts = [
    inputs.status,
    inputs.round,
    inputs.groups.map((group) => `${group.teamApiId}@${group.lng.toFixed(5)},${group.lat.toFixed(5)}`).join(","),
    inputs.trail.map((point) => `${point.id}@${point.time.toISOString()}`).join(","),
    inputs.manualVisits.map((visit) => `${visit.teamApiId}:${visit.state}`).join(","),
  ];
  return createHash("sha1").update(parts.join("|")).digest("hex");
}

/** Add walking minutes from the last trail point to every group. */
export async function gatherFacts(inputs: AreaInputs, walk: WalkMinutes, now: Date): Promise<AreaFacts> {
  const last = inputs.trail.at(-1);
  if (!last || inputs.groups.length === 0) {
    return { ...inputs, now, groups: inputs.groups.map((group) => ({ ...group, walkMinutes: 0 })), estimate: false };
  }
  const from: LngLat = [last.lng, last.lat];
  const { minutes, estimate } = await walk(
    from,
    inputs.groups.map((group): LngLat => [group.lng, group.lat]),
  );
  return { ...inputs, now, groups: inputs.groups.map((group, index) => ({ ...group, walkMinutes: minutes[index] })), estimate };
}
