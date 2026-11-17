import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Model } from "mongoose";
import { connectTestDb, disconnectTestDb } from "../test/db";
import { AreaStatusEvent } from "./area-status-event.model";
import { HintCell } from "./hint-cell.model";
import { Hunt } from "./hunt.model";
import { HuntSyncEvent } from "./hunt-sync-event.model";
import { Marker } from "./marker.model";

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

const keysOf = async (model: Model<never>) => (await model.collection.indexes()).map((index) => JSON.stringify(index.key));

/** Indexes for the hot query patterns (scraper/hunt sync each minute, marker links, fox history, trails and reach). */
describe("query indexes", () => {
  const cases: [Model<never>, Record<string, number>[]][] = [
    [Hunt as unknown as Model<never>, [{ huntTime: 1 }]],
    [Marker as unknown as Model<never>, [{ source: 1, externalId: 1 }]],
    [HintCell as unknown as Model<never>, [{ markerId: 1 }, { area: 1, publishAt: 1 }]],
    [HuntSyncEvent as unknown as Model<never>, [{ huntId: 1 }, { siteKey: 1 }]],
    [AreaStatusEvent as unknown as Model<never>, [{ at: 1 }]],
  ];
  for (const [model, wanted] of cases) {
    test(`${model.modelName}: ${wanted.map((key) => JSON.stringify(key)).join(", ")}`, async () => {
      const keys = await keysOf(model);
      for (const key of wanted) expect(keys).toContain(JSON.stringify(key));
    });
  }

  test("the hunt sync's marker lookup uses the partial source index", async () => {
    const plan = JSON.stringify(await Marker.find({ source: "jotihunt", externalId: "code:A" }).explain("queryPlanner"));
    expect(plan).toContain("source_1_externalId_1");
  });
});
