import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Model } from "mongoose";
import { Area } from "./area.model";
import { Hunt } from "./hunt.model";
import { Team } from "./team.model";
import { connectTestDb, disconnectTestDb } from "../test/db";

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

/**
 * Databases from before the unique indexes may hold duplicates. Building the index then fails (startup logs
 * "Could not build indexes for <Model>" and carries on without it); reads and upserts keep working.
 */
describe("unique indexes on a database that already holds duplicates", () => {
  const cases = [
    { model: Area, key: "name", doc: { name: "Alpha", status: "red", updatedAt: new Date() } },
    { model: Team, key: "apiId", doc: { apiId: 1, name: "G", accomodation: "x", street: "s", houseNumber: 1, postCode: "1", city: "c", location: { type: "Point", coordinates: [5, 52] } } },
    { model: Hunt, key: "huntCode", doc: { area: "Alpha", huntCode: "ABC", status: "x", points: 1, updatedAt: new Date() } },
  ] as const;

  for (const { model: typed, key, doc } of cases) {
    const model = typed as unknown as Model<Record<string, unknown>>;
    test(`${model.modelName}.${key}: index build fails without crashing, reads still work`, async () => {
      await model.collection.dropIndex(`${key}_1`);
      await model.collection.insertMany([{ ...doc }, { ...doc }]);
      await expect(model.createIndexes()).rejects.toMatchObject({ code: 11000 });
      expect(await model.countDocuments({ [key]: (doc as Record<string, unknown>)[key] })).toBe(2);
      await model.deleteMany({});
      await model.createIndexes();
      expect((await model.collection.indexes()).some((index) => index.name === `${key}_1` && index.unique)).toBe(true);
    });
  }
});
