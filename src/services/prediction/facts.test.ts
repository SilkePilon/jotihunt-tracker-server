import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GroupVisit, VisitSource, VisitState } from "../../models/group-visit.model";
import { MarkerType } from "../../models/marker.model";
import { Prediction } from "../../models/prediction.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../test/db";
import { addObservation, makeTeam, setAreaStatus } from "../../test/prediction-fixtures";
import { gatherFacts, listAreaNames, loadAreaInputs, signatureOf } from "./facts";
import { moveM } from "./geo";
import type { LngLat } from "./types";

const O: LngLat = [5.4866, 52.0806];
const T0 = Date.UTC(2026, 9, 17, 10, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

async function seedAlpha() {
  await setAreaStatus("Alpha", "green");
  await makeTeam(2, "alpha", moveM(O, 3000, 0));
  await makeTeam(1, "alpha", moveM(O, 1000, 0));
  await addObservation("alpha", at(60), moveM(O, 200, 0), MarkerType.Spot);
  await addObservation("alpha", at(0), O);
}

describe("loadAreaInputs", () => {
  test("status, groups sorted by id, trail sorted by time, round 1 by default", async () => {
    await seedAlpha();
    const inputs = await loadAreaInputs("alpha");
    expect(inputs.status).toBe("green");
    expect(inputs.round).toBe(1);
    expect(inputs.groups.map((group) => group.teamApiId)).toEqual([1, 2]);
    expect(inputs.trail.map((point) => point.kind)).toEqual(["hint", "spot"]);
    expect(inputs.manualVisits).toEqual([]);
  });

  test("manual visits of the stored round only", async () => {
    await seedAlpha();
    await Prediction.create({ area: "alpha", updatedAt: at(0), round: 2 });
    await GroupVisit.create({ area: "alpha", teamApiId: 1, round: 1, state: VisitState.Visited, source: VisitSource.Manual });
    await GroupVisit.create({ area: "alpha", teamApiId: 2, round: 2, state: VisitState.NotVisited, source: VisitSource.Manual });
    const inputs = await loadAreaInputs("alpha");
    expect(inputs.round).toBe(2);
    expect(inputs.manualVisits).toEqual([{ teamApiId: 2, state: "not_visited" }]);
  });
});

describe("signatureOf", () => {
  test("changes on a new marker, status or manual visit; stable otherwise", async () => {
    await seedAlpha();
    const base = signatureOf(await loadAreaInputs("alpha"));
    expect(signatureOf(await loadAreaInputs("alpha"))).toBe(base);
    await addObservation("alpha", at(90), O, MarkerType.Hunt);
    const withHunt = signatureOf(await loadAreaInputs("alpha"));
    expect(withHunt).not.toBe(base);
    await setAreaStatus("Alpha", "orange");
    expect(signatureOf(await loadAreaInputs("alpha"))).not.toBe(withHunt);
  });
});

describe("gatherFacts", () => {
  test("walk minutes from the last trail point, estimate passed through", async () => {
    await seedAlpha();
    const inputs = await loadAreaInputs("alpha");
    let from: LngLat | null = null;
    const facts = await gatherFacts(
      inputs,
      async (origin, to) => {
        from = origin;
        return { minutes: to.map((_, index) => 10 + index), estimate: true };
      },
      at(120),
    );
    const last = inputs.trail[1];
    expect(from as LngLat | null).toEqual([last.lng, last.lat]);
    expect(facts.groups.map((group) => group.walkMinutes)).toEqual([10, 11]);
    expect(facts.estimate).toBe(true);
    expect(facts.now).toEqual(at(120));
  });

  test("no trail: no routing, walk minutes 0", async () => {
    await setAreaStatus("Alpha", "green");
    await makeTeam(1, "alpha", O);
    const facts = await gatherFacts(await loadAreaInputs("alpha"), async () => {
      throw new Error("must not route");
    }, at(0));
    expect(facts.groups[0].walkMinutes).toBe(0);
  });
});

test("listAreaNames merges areas and team areas, lowercased", async () => {
  await setAreaStatus("Alpha", "green");
  await makeTeam(1, "Bravo", O);
  expect(await listAreaNames()).toEqual(["alpha", "bravo"]);
});
