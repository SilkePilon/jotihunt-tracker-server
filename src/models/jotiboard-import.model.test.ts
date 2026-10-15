import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { JotiboardImport } from "./jotiboard-import.model";
import { Marker, MarkerType } from "./marker.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

test("one record per kind + external id + area", async () => {
  await JotiboardImport.create({ kind: "pin", externalId: "p1", area: "alpha", result: "imported" });
  await JotiboardImport.create({ kind: "pin", externalId: "p1", area: "bravo", result: "skipped", reason: "duplicate" });
  await JotiboardImport.create({ kind: "hintSolve", externalId: "p1", area: "alpha", result: "skipped", reason: "no-cell" });
  await expect(JotiboardImport.create({ kind: "pin", externalId: "p1", area: "alpha", result: "imported" })).rejects.toMatchObject({ code: 11000 });
});

test("markers keep their Jotiboard source", async () => {
  const marker = await Marker.create({ area: "alpha", time: new Date(), type: MarkerType.Spot, location: { type: "Point", coordinates: [5, 52] }, source: "jotiboard", externalId: "p1" });
  const stored = await Marker.findById(marker._id).lean();
  expect(stored).toMatchObject({ source: "jotiboard", externalId: "p1" });
  const ours = await Marker.create({ area: "alpha", time: new Date(), type: MarkerType.Spot, location: { type: "Point", coordinates: [5, 52] } });
  expect((await Marker.findById(ours._id).lean())?.source).toBeUndefined();
});
