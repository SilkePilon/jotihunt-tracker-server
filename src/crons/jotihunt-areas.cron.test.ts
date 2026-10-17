import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Area } from "../models/area.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { parseAreasAnswer, storeAreas } from "./jotihunt-areas.cron";

const NAMES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "Oscar"];
const T = "2026-10-17T10:00:00.000000Z";
const all = (status = "green") => NAMES.map((name) => ({ name, status, updated_at: T }));

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("parseAreasAnswer", () => {
  test("a normal answer keeps all nine areas", () => {
    const parsed = parseAreasAnswer(all());
    expect(parsed?.areas.map((area) => area.name)).toEqual(NAMES);
    expect(parsed?.areas[0]).toEqual({ name: "Alpha", status: "green", updatedAt: new Date(T) });
    expect(parsed?.ignored).toBe(0);
  });

  test("unknown names, invalid statuses and null entries are dropped; names are stored as the API writes them", () => {
    const parsed = parseAreasAnswer([
      { name: "ALPHA", status: "orange", updated_at: T },
      { name: "Area1", status: "red", updated_at: T },
      { name: "Bravo", status: "<script>", updated_at: T },
      null as never,
      { name: "Charlie", status: "red", updated_at: "garbage" },
    ]);
    expect(parsed?.areas).toEqual([
      { name: "Alpha", status: "orange", updatedAt: new Date(T) },
      { name: "Charlie", status: "red" },
    ]);
    expect(parsed?.ignored).toBe(3);
    expect(parsed?.unknownStatuses).toEqual([{ area: "Bravo", status: "<script>" }]);
  });

  test("blue (OV) is a known status; unknown statuses are reported with their area", () => {
    const parsed = parseAreasAnswer([
      { name: "Oscar", status: "blue", updated_at: T },
      { name: "Hotel", status: "purple", updated_at: T },
    ]);
    expect(parsed?.areas).toEqual([{ name: "Oscar", status: "blue", updatedAt: new Date(T) }]);
    expect(parsed?.ignored).toBe(1);
    expect(parsed?.unknownStatuses).toEqual([{ area: "Hotel", status: "purple" }]);
  });

  test("an answer without known areas, or far more entries than areas, is ignored as a whole", () => {
    expect(parseAreasAnswer([])).toBeNull();
    expect(parseAreasAnswer([{ name: "Area1", status: "red", updated_at: T }])).toBeNull();
    const huge = Array.from({ length: 50 }, (_, index) => ({ name: `Area${index}`, status: "red", updated_at: T }));
    expect(parseAreasAnswer([...all(), ...huge])).toBeNull();
  });
});

describe("storeAreas", () => {
  test("a partial answer updates the areas it has and keeps the others", async () => {
    await storeAreas(parseAreasAnswer(all("red"))!.areas);
    await storeAreas(parseAreasAnswer([{ name: "Alpha", status: "green", updated_at: T }])!.areas);
    const areas = await Area.find().sort({ name: 1 }).lean();
    expect(areas).toHaveLength(9);
    expect(areas.find((area) => area.name === "Alpha")?.status).toBe("green");
    expect(areas.filter((area) => area.status === "red")).toHaveLength(8);
  });

  test("an area without a valid time keeps its stored time (new ones get now)", async () => {
    await storeAreas([{ name: "Alpha", status: "red", updatedAt: new Date(T) }]);
    await storeAreas([{ name: "Alpha", status: "green" }, { name: "Bravo", status: "red" }]);
    const alpha = await Area.findOne({ name: "Alpha" }).lean();
    expect(alpha?.status).toBe("green");
    expect(alpha?.updatedAt).toEqual(new Date(T));
    expect((await Area.findOne({ name: "Bravo" }).lean())?.updatedAt).toBeInstanceOf(Date);
  });

  test("names that are not an area (left by an earlier broken answer) are removed", async () => {
    await Area.create([
      { name: "Area1", status: "red", updatedAt: new Date() },
      { name: "Alpha", status: "red", updatedAt: new Date() },
    ]);
    await storeAreas([{ name: "Bravo", status: "green", updatedAt: new Date(T) }]);
    expect((await Area.find().lean()).map((area) => area.name).sort()).toEqual(["Alpha", "Bravo"]);
  });

  test("the area name is unique", async () => {
    await Area.create({ name: "Alpha", status: "red", updatedAt: new Date() });
    await expect(Area.create({ name: "Alpha", status: "green", updatedAt: new Date() })).rejects.toMatchObject({ code: 11000 });
  });
});
