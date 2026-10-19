import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { Marker, MarkerType } from "../models/marker.model";
import { trailsService } from "../services/routes/instance";
import { setLegMode } from "./trails.controller";

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

const invalidate = spyOn(trailsService, "invalidate");
afterEach(() => invalidate.mockClear());
afterAll(() => invalidate.mockRestore());

function fakeRes() {
  const res = { statusCode: 0, body: undefined as unknown, status(code: number) { res.statusCode = code; return res; }, json(body: unknown) { res.body = body; return res; } };
  return res;
}

describe("setLegMode", () => {
  test("sets and clears the override", async () => {
    const marker = await Marker.create({ area: "alpha", time: new Date(), location: { type: "Point", coordinates: [5.9, 52] }, type: MarkerType.Hint });
    let res = fakeRes();
    await setLegMode({ params: { markerId: String(marker._id) }, body: { legMode: "car" } } as never, res as never);
    expect(res.body).toEqual({ _id: String(marker._id), legMode: "car" });
    expect(invalidate).toHaveBeenCalledTimes(1);
    res = fakeRes();
    await setLegMode({ params: { markerId: String(marker._id) }, body: { legMode: null } } as never, res as never);
    expect((await Marker.findById(marker._id).lean())?.legMode).toBeUndefined();
  });

  test("404 for unknown marker", async () => {
    const res = fakeRes();
    await setLegMode({ params: { markerId: "6530f0f0f0f0f0f0f0f0f0f0" }, body: { legMode: "walk" } } as never, res as never);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ message: "Marker niet gevonden." });
    expect(invalidate).not.toHaveBeenCalled();
  });
});
