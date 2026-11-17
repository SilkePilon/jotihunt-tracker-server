import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import compression from "compression";
import express from "express";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { nextGeneration } from "../editions/work-tracking";
import { Hunt } from "../models/hunt.model";
import { Marker, MarkerType } from "../models/marker.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { cachedJson, invalidateResponseCache, sendPreparedJson, type CachedList } from "./response-cache";

let builds = 0;
/** Read the list through the cache with a long TTL; `builds` counts the real builds */
function read(list: CachedList = "markers") {
  return cachedJson(
    list,
    async () => {
      builds++;
      return list === "markers" ? Marker.find().lean() : Hunt.find().lean();
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
  invalidateResponseCache("hunts");
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

describe("hunt writes clear the cached hunts", () => {
  test("the scraper's bulk upsert and a delete", async () => {
    const hunt = { siteKey: "qr:A", area: "alpha", status: "Wacht", points: 0, updatedAt: new Date() };
    expect(await invalidates(() => Hunt.bulkWrite([{ updateOne: { filter: { siteKey: "qr:A" }, update: { $set: hunt }, upsert: true } }]), "hunts")).toBe(true);
    expect(await invalidates(() => Hunt.deleteMany({}), "hunts")).toBe(true);
  });
});

describe("sendPreparedJson", () => {
  const big = JSON.stringify(Array.from({ length: 200 }, (_, index) => ({ id: index, name: `Vos ${index}` })));
  let body = big;
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    const app = express();
    // Same setup as the app: the compression middleware in front
    app.use(compression());
    app.get("/list", (req, res) => sendPreparedJson(req, res, "test-list", body));
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.close();
  });

  /** Raw response (no automatic decompression) */
  function get(headers: Record<string, string> = {}) {
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      http
        .get({ port, path: "/list", headers }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
        })
        .on("error", reject);
    });
  }

  test("gzips once (not twice) when the client accepts gzip, with Vary and an ETag", async () => {
    body = big;
    const res = await get({ "Accept-Encoding": "gzip, deflate, br" });
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers.vary).toContain("Accept-Encoding");
    expect(res.headers.etag).toMatch(/^W\/"/);
    // One gunzip gives the JSON back: gzipped twice it would still be gzip bytes here
    const once = gunzipSync(res.body);
    expect(once.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))).toBe(false);
    expect(once.toString()).toBe(big);
  });

  test("plain body without Accept-Encoding gzip; same ETag", async () => {
    body = big;
    const zipped = await get({ "Accept-Encoding": "gzip" });
    const plain = await get({ "Accept-Encoding": "identity" });
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.body.toString()).toBe(big);
    expect(plain.headers.etag).toBe(zipped.headers.etag);
  });

  test("304 without a body when the ETag matches; a new body gets a new ETag", async () => {
    body = big;
    const first = await get({ "Accept-Encoding": "gzip" });
    const again = await get({ "Accept-Encoding": "gzip", "If-None-Match": first.headers.etag! });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);

    body = JSON.stringify([{ id: 1 }, ...JSON.parse(big)]);
    const changed = await get({ "Accept-Encoding": "gzip", "If-None-Match": first.headers.etag! });
    expect(changed.status).toBe(200);
    expect(changed.headers.etag).not.toBe(first.headers.etag);
    expect(gunzipSync(changed.body).toString()).toBe(body);
  });

  test("small bodies are sent as is", async () => {
    body = "[]";
    const res = await get({ "Accept-Encoding": "gzip" });
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.body.toString()).toBe("[]");
  });
});
