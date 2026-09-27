import { describe, expect, test } from "bun:test";
import { moveM } from "./geo";
import type { GroupRef, LngLat, Observation } from "./types";
import { assignRounds, candidateIds, detectPointVisits, detectRouteVisits, type VisitEvent } from "./visits";

const O: LngLat = [5.4866, 52.0806];
const T0 = Date.UTC(2026, 9, 17, 10, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const group = (teamApiId: number, [lng, lat]: LngLat): GroupRef => ({ teamApiId, name: `G${teamApiId}`, lng, lat });
const obs = (minutes: number, [lng, lat]: LngLat): Observation => ({ time: at(minutes), lng, lat, kind: "hint" });
const event = (teamApiId: number, minutes: number, evidence: VisitEvent["evidence"] = "point"): VisitEvent => ({ teamApiId, time: at(minutes), evidence });

describe("detectPointVisits", () => {
  test("an observation within 300 m of a group is a visit", () => {
    const groups = [group(1, moveM(O, 200, 0)), group(2, moveM(O, 400, 0))];
    expect(detectPointVisits([obs(0, O)], groups)).toEqual([{ teamApiId: 1, time: at(0), evidence: "point" }]);
  });
});

describe("detectRouteVisits", () => {
  test("a route passing within 300 m gives an interpolated visit time", () => {
    const from = obs(0, O);
    const to = obs(60, moveM(O, 2000, 0));
    const line: LngLat[] = [
      [from.lng, from.lat],
      [to.lng, to.lat],
    ];
    const events = detectRouteVisits(from, to, line, [group(1, moveM(O, 1000, 150)), group(2, moveM(O, 1000, 600))]);
    expect(events).toHaveLength(1);
    expect(events[0].teamApiId).toBe(1);
    expect(events[0].evidence).toBe("route");
    expect(Math.abs(events[0].time.getTime() - at(30).getTime())).toBeLessThan(60_000);
  });
});

describe("assignRounds", () => {
  const ids = [1, 2];

  test("collects auto visits in round 1", () => {
    const state = assignRounds(ids, [event(1, 0)], []);
    expect(state.currentRound).toBe(1);
    expect([...state.visitedInCurrent]).toEqual([1]);
    expect(state.autoVisits).toEqual([{ teamApiId: 1, round: 1, visitedAt: at(0), evidence: "point" }]);
  });

  test("repeat detections in the same round are ignored", () => {
    expect(assignRounds(ids, [event(1, 10), event(1, 0)], []).autoVisits).toEqual([{ teamApiId: 1, round: 1, visitedAt: at(0), evidence: "point" }]);
  });

  test("ignores groups that are not part of the area", () => {
    expect(assignRounds(ids, [event(9, 0)], []).autoVisits).toEqual([]);
  });

  test("manual not_visited wins over auto", () => {
    const state = assignRounds(ids, [event(1, 0)], [{ teamApiId: 1, round: 1, state: "not_visited" }]);
    expect(state.autoVisits).toEqual([]);
    expect(state.visitedInCurrent.has(1)).toBe(false);
  });

  test("manual visited counts towards completing the round", () => {
    const state = assignRounds(ids, [event(2, 30, "route")], [{ teamApiId: 1, round: 1, state: "visited", visitedAt: at(0) }]);
    expect(state.currentRound).toBe(2);
    expect(state.lastOfPrevious).toEqual({ teamApiId: 2, visitedAt: at(30) });
    expect(state.visitedInCurrent.size).toBe(0);
  });

  test("round rollover with the 30-minute rule for the last group", () => {
    const state = assignRounds(ids, [event(1, 0), event(2, 60), event(2, 80), event(2, 100)], []);
    expect(state.currentRound).toBe(2);
    expect(state.autoVisits.map((visit) => [visit.teamApiId, visit.round, visit.visitedAt])).toEqual([
      [1, 1, at(0)],
      [2, 1, at(60)],
      [2, 2, at(100)],
    ]);
    expect([...state.visitedInCurrent]).toEqual([2]);
  });
});

describe("candidateIds", () => {
  test("excludes visited groups and the previous round's last group for 30 minutes", () => {
    const groupIds = [1, 2, 3];
    const state = assignRounds(groupIds, [event(1, 0), event(2, 30), event(3, 60)], []);
    expect(state.currentRound).toBe(2);
    expect(candidateIds(groupIds, state, at(70))).toEqual([1, 2]);
    expect(candidateIds(groupIds, state, at(91))).toEqual([1, 2, 3]);
  });

  test("excludes groups visited in the current round", () => {
    const state = assignRounds([1, 2, 3], [event(2, 0)], []);
    expect(candidateIds([1, 2, 3], state, at(10))).toEqual([1, 3]);
  });
});
