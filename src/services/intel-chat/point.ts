import type { SolvedHintPoint, TrackerFix } from "./data";
import { estimateArea, formatCoordinate, insideNl, metresBetween, nearestGroups, type AreaEstimate, type AreaGroup, type LatLng, type NearGroup, type ParsedCoordinate, type Rd } from "./geo";

/** Output of showPoint, and the point of checkPoint / proposeHintAnswer (contract: PointResult) */
export interface PointResult {
  label: string;
  latLng: LatLng;
  rd: Rd;
  rdText: string;
  area: AreaEstimate;
  nearestGroup: NearGroup | null;
}

export interface CheckPointResult {
  point: PointResult;
  nearestGroups: NearGroup[];
  insideNl: boolean;
  otherHintPoints: { articleTitle: string; slotTime: string | null; distanceM: number }[];
  nearestTracker: { name: string; distanceM: number; ageMin: number } | null;
}

const MAX_LABEL = 80;

export function pointResult(parsed: ParsedCoordinate, label: string, groups: AreaGroup[]): PointResult {
  return {
    label: label.trim().slice(0, MAX_LABEL) || formatCoordinate(parsed).rd8,
    latLng: { lat: Number(parsed.latLng.lat.toFixed(6)), lng: Number(parsed.latLng.lng.toFixed(6)) },
    rd: { x: Math.round(parsed.rd.x), y: Math.round(parsed.rd.y) },
    rdText: formatCoordinate(parsed).rd8,
    area: estimateArea(parsed.latLng, groups),
    nearestGroup: nearestGroups(parsed.latLng, groups, 1)[0] ?? null,
  };
}

export interface CheckPointData {
  groups: AreaGroup[];
  hintPoints: SolvedHintPoint[];
  trackers: TrackerFix[];
}

/**
 * Everything worth knowing about a candidate point: area estimate, the 5 nearest groups, whether it is in the
 * Netherlands, distances to the other solved hint points of the area (`area`, else the estimated one; the current
 * item's own cells left out) and our nearest tracker.
 */
export function checkPointResult(parsed: ParsedCoordinate, options: CheckPointData & { label?: string; area?: string | null; articleId: number; now: Date }): CheckPointResult {
  const point = pointResult(parsed, options.label ?? "", options.groups);
  const area = options.area ?? point.area.area;
  const otherHintPoints = area
    ? options.hintPoints
        .filter((hint) => hint.area === area && hint.articleId !== options.articleId)
        .slice(0, 10)
        .map((hint) => ({ articleTitle: hint.articleTitle, slotTime: hint.slotTime ? hint.slotTime.toISOString() : null, distanceM: metresBetween(parsed.latLng, hint) }))
    : [];
  const trackers = options.trackers
    .map((tracker) => ({ name: tracker.name, distanceM: metresBetween(parsed.latLng, tracker), ageMin: Math.max(0, Math.round((options.now.getTime() - tracker.at.getTime()) / 60_000)) }))
    .sort((a, b) => a.distanceM - b.distanceM);
  return {
    point,
    nearestGroups: nearestGroups(parsed.latLng, options.groups, 5),
    insideNl: insideNl(parsed.latLng),
    otherHintPoints,
    nearestTracker: trackers[0] ?? null,
  };
}
