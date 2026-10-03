import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Team } from "../models/team.model";
import { ApiTeam } from "../types/api";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { syncTeams } from "./team-sync.service";

function apiTeam(id: number, overrides: Partial<ApiTeam> = {}): ApiTeam {
  return {
    id,
    name: `Groep ${id}`,
    accomodation: "Clubhuis",
    street: "Straat",
    housenumber: id,
    housenumber_addition: "",
    postcode: "1234AB",
    city: "Stad",
    lat: "52.1",
    long: "5.1",
    area: null,
    ...overrides,
  };
}

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("syncTeams", () => {
  test("inserts new teams with numeric coordinates", async () => {
    expect(await syncTeams(async () => [apiTeam(1), apiTeam(2)])).toBe(2);
    const team = await Team.findOne({ apiId: 1 }).lean();
    expect(team!.location.coordinates).toEqual([5.1, 52.1]);
  });

  test("keeps an area and logo set in the app when the API has no area", async () => {
    await syncTeams(async () => [apiTeam(1)]);
    await Team.updateOne({ apiId: 1 }, { $set: { area: "Alpha", logoUrl: "https://cdn/logo.png" } });

    await syncTeams(async () => [apiTeam(1, { name: "Nieuwe naam" })]);

    const team = await Team.findOne({ apiId: 1 }).lean();
    expect(team).toMatchObject({ name: "Nieuwe naam", area: "Alpha", logoUrl: "https://cdn/logo.png" });
  });

  test("takes the area from the API when it provides one", async () => {
    await syncTeams(async () => [apiTeam(1)]);
    await Team.updateOne({ apiId: 1 }, { $set: { area: "Alpha" } });
    await syncTeams(async () => [apiTeam(1, { area: "Bravo" })]);
    expect((await Team.findOne({ apiId: 1 }).lean())!.area).toBe("Bravo");
  });

  test("removes teams that are no longer subscribed", async () => {
    await syncTeams(async () => [apiTeam(1), apiTeam(2)]);
    await syncTeams(async () => [apiTeam(2)]);
    expect((await Team.find().lean()).map((team) => team.apiId)).toEqual([2]);
  });

  test("a much shorter answer (broken API) upserts but removes nothing", async () => {
    await syncTeams(async () => [1, 2, 3, 4, 5, 6].map((id) => apiTeam(id)));
    await syncTeams(async () => [apiTeam(1), apiTeam(2)]);
    expect(await Team.countDocuments()).toBe(6);
  });

  test("entries without a numeric id are skipped", async () => {
    expect(await syncTeams(async () => [apiTeam(1), { ...apiTeam(2), id: null } as unknown as ApiTeam])).toBe(1);
    expect((await Team.find().lean()).map((team) => team.apiId)).toEqual([1]);
  });

  test("an empty API answer changes nothing", async () => {
    await syncTeams(async () => [apiTeam(1)]);
    await expect(syncTeams(async () => [])).rejects.toThrow();
    expect(await Team.countDocuments()).toBe(1);
  });
});
