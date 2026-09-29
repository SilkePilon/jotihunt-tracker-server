import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GroupVisit, VisitSource, VisitState } from "../../models/group-visit.model";
import { Prediction } from "../../models/prediction.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../test/db";
import { makeTeam } from "../../test/prediction-fixtures";
import { listCurrentVisits, setManualVisit } from "./visit.service";

const O: [number, number] = [5.48, 52.08];
beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("visits", () => {
  test("AI visits listed as auto; manual override wins", async () => {
    await makeTeam(1, "alpha", O);
    await makeTeam(2, "alpha", O);
    await Prediction.create({ area: "alpha", updatedAt: new Date(), round: 1, visitedTeamApiIds: [1, 2] });
    await setManualVisit(2, "not_visited");
    const visits = await listCurrentVisits();
    expect(visits.map((visit) => [visit.teamApiId, visit.state, visit.source])).toEqual([
      [1, "visited", "auto"],
      [2, "not_visited", "manual"],
    ]);
  });

  test("auto removes the manual override and reports the AI state", async () => {
    await makeTeam(1, "alpha", O);
    await Prediction.create({ area: "alpha", updatedAt: new Date(), round: 1, visitedTeamApiIds: [1] });
    await setManualVisit(1, "not_visited");
    const result = await setManualVisit(1, "auto");
    expect(result?.visit).toMatchObject({ state: "visited", source: "auto" });
    expect(await GroupVisit.countDocuments()).toBe(0);
  });

  test("manual visits of another round are not listed; unknown team is null", async () => {
    await makeTeam(1, "alpha", O);
    await Prediction.create({ area: "alpha", updatedAt: new Date(), round: 2 });
    await GroupVisit.create({ area: "alpha", teamApiId: 1, round: 1, state: VisitState.Visited, source: VisitSource.Manual });
    expect(await listCurrentVisits()).toEqual([]);
    expect(await setManualVisit(999, "visited")).toBeNull();
  });
});
