import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { nextGeneration } from "../demo/demo-mode";
import { HuntReport } from "../models/hunt-report.model";
import { Marker, MarkerType } from "../models/marker.model";
import { User } from "../models/user.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { createHuntReport, setHuntReportSubmitted } from "./hunt-report.service";
import { cachedJson, invalidateResponseCache, type CachedList } from "./response-cache";

process.env.UPLOADS_DIR = mkdtempSync(path.join(tmpdir(), "response-cache-"));

let builds = 0;
/** Read the list through the cache with a long TTL; `builds` counts the real builds */
function read(list: CachedList = "markers") {
  return cachedJson(
    list,
    async () => {
      builds++;
      return list === "markers" ? Marker.find().lean() : HuntReport.find().lean();
    },
    60_000,
  );
}

/** True when `write` makes the next read build the list again */
async function invalidates(write: () => Promise<unknown>, list: CachedList = "markers") {
  await read(list);
  const before = builds;
  await read(list);
  expect(builds).toBe(before);
  await write();
  await read(list);
  return builds > before;
}

const marker = (minute = 0) => ({ area: "alpha", time: new Date(Date.UTC(2026, 9, 17, 12, minute)), type: MarkerType.Spot, location: { type: "Point" as const, coordinates: [5.9, 52.2] } });

beforeAll(connectTestDb);
beforeEach(async () => {
  await clearTestDb();
  invalidateResponseCache("markers");
  invalidateResponseCache("huntReports");
});
afterAll(disconnectTestDb);

describe("cachedJson", () => {
  test("concurrent and later callers within the TTL share one build; the body is the JSON", async () => {
    await Marker.create(marker());
    const bodies = await Promise.all([read(), read(), read()]);
    const before = builds;
    expect(await read()).toBe(bodies[0]);
    expect(builds).toBe(before);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toEqual(JSON.parse(JSON.stringify(await Marker.find().lean())));
  });

  test("builds again after the TTL", async () => {
    let count = 0;
    const build = async () => ++count;
    expect(await cachedJson("hunts", build, 5)).toBe("1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await cachedJson("hunts", build, 5)).toBe("2");
    invalidateResponseCache("hunts");
  });

  test("a failed build is not served to the next caller", async () => {
    await expect(cachedJson("articles", async () => Promise.reject(new Error("down")), 60_000)).rejects.toThrow("down");
    expect(await cachedJson("articles", async () => ["ok"], 60_000)).toBe('["ok"]');
    invalidateResponseCache("articles");
  });

  test("a demo switch (new database generation) never serves the previous database's list", async () => {
    await read();
    const before = builds;
    nextGeneration();
    await read();
    expect(builds).toBe(before + 1);
  });
});

describe("every marker write clears the cached markers", () => {
  test("create, insertMany, bulkWrite", async () => {
    expect(await invalidates(() => Marker.create(marker(1)))).toBe(true);
    expect(await invalidates(() => Marker.insertMany([marker(2)]))).toBe(true);
    expect(await invalidates(() => Marker.bulkWrite([{ insertOne: { document: marker(3) } }]))).toBe(true);
  });

  test("updates and deletes as queries and on documents", async () => {
    const doc = await Marker.create(marker(1));
    expect(await invalidates(() => Marker.updateOne({ _id: doc._id }, { $set: { area: "bravo" } }))).toBe(true);
    expect(await invalidates(() => Marker.updateMany({}, { $set: { area: "charlie" } }))).toBe(true);
    expect(await invalidates(() => Marker.findByIdAndUpdate(doc._id, { $set: { area: "delta" } }))).toBe(true);
    expect(await invalidates(async () => {
      doc.area = "echo";
      await doc.save();
    })).toBe(true);
    expect(await invalidates(() => doc.deleteOne())).toBe(true);
    const other = await Marker.create(marker(2));
    expect(await invalidates(() => Marker.findByIdAndDelete(other._id))).toBe(true);
    await Marker.create(marker(3));
    expect(await invalidates(() => Marker.deleteOne({}))).toBe(true);
    await Marker.create(marker(4));
    expect(await invalidates(() => Marker.deleteMany({}))).toBe(true);
  });

  test("a read does not clear it", async () => {
    expect(await invalidates(() => Marker.find())).toBe(false);
  });
});

describe("hunt report writes clear the cached hunt reports", () => {
  test("upload and status change", async () => {
    const user = await User.create({ name: "hq", admin: true });
    const photo = { buffer: Buffer.from([0xff, 0xd8, 0xff]), mimetype: "image/jpeg" };
    let id = "";
    expect(
      await invalidates(async () => {
        id = (await createHuntReport({ area: "alpha", huntCode: "ABC", huntTime: new Date(), photo }, user))._id;
      }, "huntReports"),
    ).toBe(true);
    expect(await invalidates(() => setHuntReportSubmitted(id, true, user), "huntReports")).toBe(true);
    expect(await invalidates(() => HuntReport.updateOne({ _id: id }, { $set: { deadlineWarnedAt: new Date() } }), "huntReports")).toBe(true);
  });
});
