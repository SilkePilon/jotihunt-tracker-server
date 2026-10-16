import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Request, Response } from "express";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Article, publicArticlesFilter } from "../models/article.model";
import { Hunt } from "../models/hunt.model";
import { Marker, MarkerType } from "../models/marker.model";
import { invalidateResponseCache } from "../services/response-cache";
import { listSyncedHunts } from "../services/hunt-sync.view";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { getArticles } from "./articles.controller";
import { getHunts } from "./hunts.controller";
import { getMarkers } from "./markers.controller";

process.env.UPLOADS_DIR = mkdtempSync(path.join(tmpdir(), "polled-lists-"));

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    sentFile: undefined as string | undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    set(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
      return res;
    },
    setHeader(name: string, value: string) {
      return res.set(name, value);
    },
    send(body: string) {
      res.body = body;
      return res;
    },
    json(body: unknown) {
      res.body = JSON.stringify(body);
      return res;
    },
    sendFile(file: string) {
      res.sentFile = file;
      return res;
    },
  };
  return res;
}

async function call(handler: (req: Request, res: Response) => unknown, req: Partial<Request> = {}) {
  const res = fakeRes();
  await handler(req as Request, res as unknown as Response);
  return res;
}

/** What res.json of the hydrated documents used to send */
const asJson = (value: unknown) => JSON.parse(JSON.stringify(value));

beforeAll(connectTestDb);
beforeEach(async () => {
  await clearTestDb();
  for (const list of ["markers", "articles", "hunts"] as const) invalidateResponseCache(list);
});
afterAll(disconnectTestDb);

describe("polled list endpoints", () => {
  test("send exactly the JSON the uncached endpoints sent", async () => {
    await Marker.create({ area: "bravo", time: new Date("2026-10-17T13:00:00Z"), type: MarkerType.Hint, location: { type: "Point", coordinates: [5.8, 52.1] } });
    await Article.create([
      { id: 1, title: "Oud", type: "hint", publishAt: new Date("2026-10-17T12:00:00Z"), content: "<p>a</p>", messageType: "html", maxPoints: 5, endTime: new Date("2026-10-17T14:00:00Z") },
      { id: 2, title: "Nieuw", type: "news", publishAt: new Date("2026-10-17T14:00:00Z"), content: "b" },
      { id: 900001, title: "Test", type: "hint", publishAt: new Date("2026-10-17T15:00:00Z"), content: "c" },
    ]);
    await Hunt.create({ area: "alpha", huntCode: "ABC", status: "Goedgekeurd", points: 5, huntTime: new Date(), updatedAt: new Date() });

    const markers = await call(getMarkers);
    expect(markers.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(JSON.parse(markers.body as string)).toEqual(asJson(await Marker.find().lean()));
    expect(JSON.parse((await call(getArticles)).body as string)).toEqual(asJson(await Article.find(publicArticlesFilter()).sort({ publishAt: -1 })));
    expect(JSON.parse((await call(getHunts)).body as string)).toEqual(asJson(await listSyncedHunts()));
  });

  test("a new marker shows up at once", async () => {
    expect(JSON.parse((await call(getMarkers)).body as string)).toHaveLength(0);
    await Marker.create({ area: "bravo", time: new Date(), type: MarkerType.Spot, location: { type: "Point", coordinates: [5.8, 52.1] } });
    expect(JSON.parse((await call(getMarkers)).body as string)).toHaveLength(1);
  });
});
