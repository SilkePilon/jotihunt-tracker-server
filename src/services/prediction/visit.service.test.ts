import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GroupVisit, VisitSource, VisitState } from "../../models/group-visit.model";
import { Prediction } from "../../models/prediction.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../test/db";
import { makeTeam } from "../../test/prediction-fixtures";
import type { LngLat } from "./types";
import { listCurrentVisits, loadManualVisits, manualVisitsVersion, replaceAutoVisits, setManualVisit } from "./visit.service";

const O: LngLat = [5.4866, 52.0806];
const T = new Date("2026-10-17T10:00:00.000Z");

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("GroupVisit", () => {
  test("one doc per (team, round)", async () => {
    await GroupVisit.create({ area: "alpha", teamApiId: 1, round: 1, state: VisitState.Visited, source: VisitSource.Auto });
    await expect(GroupVisit.create({ area: "alpha", teamApiId: 1, round: 1, state: VisitState.Visited, source: VisitSource.Manual })).rejects.toThrow();
  });
});

describe("replaceAutoVisits", () => {
  test("replaces the area's auto visits and keeps manual ones", async () => {
    await GroupVisit.create({ area: "alpha", teamApiId: 1, round: 1, state: VisitState.NotVisited, source: VisitSource.Manual });
    await replaceAutoVisits("alpha", [{ teamApiId: 2, round: 1, visitedAt: T, evidence: "point" }]);
    await replaceAutoVisits("alpha", [{ teamApiId: 3, round: 1, visitedAt: T, evidence: "route" }]);
    const docs = await GroupVisit.find().sort({ teamApiId: 1 }).lean();
    expect(docs.map((doc) => [doc.teamApiId, doc.source, doc.evidence ?? null])).toEqual([
      [1, "manual", null],
      [3, "auto", "route"],
    ]);
  });
});

describe("setManualVisit", () => {
  test("overrides an auto visit; 'auto' removes the override", async () => {
    await makeTeam(7, "Alpha", O);
    await replaceAutoVisits("alpha", [{ teamApiId: 7, round: 1, visitedAt: T, evidence: "point" }]);
    const versionBefore = await manualVisitsVersion("alpha");

    const manual = await setManualVisit(7, "not_visited", T);
    expect(manual).toMatchObject({ area: "alpha", visit: { teamApiId: 7, round: 1, state: "not_visited", source: "manual", visitedAt: null } });
    expect(await loadManualVisits("alpha")).toEqual([{ teamApiId: 7, round: 1, state: "not_visited", visitedAt: null }]);
    expect(await manualVisitsVersion("alpha")).not.toBe(versionBefore);

    const reset = await setManualVisit(7, "auto", T);
    expect(reset?.visit).toEqual({ area: "alpha", teamApiId: 7, round: 1, state: "not_visited", source: "auto", visitedAt: null });
    expect(await loadManualVisits("alpha")).toEqual([]);
  });

  test("uses the current round stored on the prediction", async () => {
    await makeTeam(7, "alpha", O);
    await Prediction.create({ area: "alpha", round: 2, updatedAt: T });
    const result = await setManualVisit(7, "visited", T);
    expect(result?.visit).toMatchObject({ round: 2, state: "visited", source: "manual", visitedAt: T });
  });

  test("null for unknown teams or teams without an area", async () => {
    expect(await setManualVisit(999, "visited", T)).toBeNull();
    await makeTeam(8, "", O);
    expect(await setManualVisit(8, "visited", T)).toBeNull();
  });
});

describe("listCurrentVisits", () => {
  test("only visits of each area's current round", async () => {
    await Prediction.create({ area: "alpha", round: 2, updatedAt: T });
    await replaceAutoVisits("alpha", [
      { teamApiId: 1, round: 1, visitedAt: T, evidence: "point" },
      { teamApiId: 2, round: 2, visitedAt: T, evidence: "point" },
    ]);
    await replaceAutoVisits("bravo", [{ teamApiId: 3, round: 1, visitedAt: T, evidence: "route" }]);
    const visits = await listCurrentVisits();
    expect(visits.map((visit) => visit.teamApiId).sort()).toEqual([2, 3]);
    expect(visits.find((visit) => visit.teamApiId === 3)).toEqual({ area: "bravo", teamApiId: 3, round: 1, state: "visited", source: "auto", visitedAt: T });
  });
});
