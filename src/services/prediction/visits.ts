import { REPEAT_EXCLUSION_MIN, VISIT_RADIUS_M } from "./constants";
import { distanceM, pointToLine } from "./geo";
import type { GroupRef, LngLat, Observation } from "./types";

export type VisitStateValue = "visited" | "not_visited";

export interface VisitEvent {
  teamApiId: number;
  time: Date;
  evidence: "point" | "route";
}

export interface ManualVisit {
  teamApiId: number;
  round: number;
  state: VisitStateValue;
  visitedAt?: Date | null;
}

export interface AutoVisit {
  teamApiId: number;
  round: number;
  visitedAt: Date;
  evidence: "point" | "route";
}

export interface RoundState {
  currentRound: number;
  visitedInCurrent: Set<number>;
  /** The group visited last in the previous round (30-minute rule), if any */
  lastOfPrevious: { teamApiId: number; visitedAt: Date } | null;
  autoVisits: AutoVisit[];
}

const REPEAT_MS = REPEAT_EXCLUSION_MIN * 60_000;

/** Every (observation, group) pair within the radius is a visit at the observation time. */
export function detectPointVisits(observations: Observation[], groups: GroupRef[], radiusM = VISIT_RADIUS_M): VisitEvent[] {
  const events: VisitEvent[] = [];
  for (const observation of observations) {
    for (const group of groups) {
      if (distanceM([observation.lng, observation.lat], [group.lng, group.lat]) <= radiusM) {
        events.push({ teamApiId: group.teamApiId, time: observation.time, evidence: "point" });
      }
    }
  }
  return events;
}

/**
 * Groups the walking route between two consecutive observations passes within the radius.
 * The visit time is interpolated along the route.
 */
export function detectRouteVisits(from: Observation, to: Observation, line: LngLat[], groups: GroupRef[], radiusM = VISIT_RADIUS_M): VisitEvent[] {
  const span = to.time.getTime() - from.time.getTime();
  return groups.flatMap((group) => {
    const { distanceM: distance, fraction } = pointToLine([group.lng, group.lat], line);
    if (distance > radiusM) return [];
    return [{ teamApiId: group.teamApiId, time: new Date(from.time.getTime() + fraction * span), evidence: "route" as const }];
  });
}

/**
 * Replay visit events in time order and split them into rounds. Manual visits always win:
 * a manual doc for (group, round) blocks auto visits for that pair, and manual `visited`
 * counts towards completing the round. A round is complete when every group is visited;
 * the next round then starts, and the group visited last may only count again 30 minutes later.
 */
export function assignRounds(groupIds: number[], events: VisitEvent[], manual: ManualVisit[]): RoundState {
  const known = new Set(groupIds);
  const autoVisits: AutoVisit[] = [];
  const progress: { round: number; lastOfPrevious: RoundState["lastOfPrevious"] } = { round: 1, lastOfPrevious: null };

  const manualFor = (teamApiId: number, round: number) => manual.find((visit) => visit.teamApiId === teamApiId && visit.round === round);
  const visitedAtIn = (teamApiId: number, round: number): Date | null => {
    const override = manualFor(teamApiId, round);
    if (override) return override.state === "visited" ? (override.visitedAt ?? new Date(0)) : null;
    return autoVisits.find((visit) => visit.teamApiId === teamApiId && visit.round === round)?.visitedAt ?? null;
  };
  const advance = () => {
    while (groupIds.length > 0 && groupIds.every((id) => visitedAtIn(id, progress.round) !== null)) {
      const visits = groupIds.map((id) => ({ teamApiId: id, visitedAt: visitedAtIn(id, progress.round) as Date }));
      visits.sort((a, b) => b.visitedAt.getTime() - a.visitedAt.getTime());
      progress.lastOfPrevious = visits[0];
      progress.round++;
    }
  };

  advance();
  for (const event of [...events].sort((a, b) => a.time.getTime() - b.time.getTime())) {
    if (!known.has(event.teamApiId)) continue;
    if (manualFor(event.teamApiId, progress.round)) continue;
    if (visitedAtIn(event.teamApiId, progress.round) !== null) continue;
    const last = progress.lastOfPrevious;
    if (last && last.teamApiId === event.teamApiId && event.time.getTime() - last.visitedAt.getTime() < REPEAT_MS) continue;
    autoVisits.push({ teamApiId: event.teamApiId, round: progress.round, visitedAt: event.time, evidence: event.evidence });
    advance();
  }

  return {
    currentRound: progress.round,
    visitedInCurrent: new Set(groupIds.filter((id) => visitedAtIn(id, progress.round) !== null)),
    lastOfPrevious: progress.lastOfPrevious,
    autoVisits,
  };
}

/** Groups that can still be visited next: not visited this round and not blocked by the 30-minute rule. */
export function candidateIds(groupIds: number[], state: RoundState, now: Date): number[] {
  return groupIds.filter((id) => {
    if (state.visitedInCurrent.has(id)) return false;
    const last = state.lastOfPrevious;
    return !(last && last.teamApiId === id && now.getTime() - last.visitedAt.getTime() < REPEAT_MS);
  });
}
