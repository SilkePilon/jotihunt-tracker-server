import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Request, Response } from "express";
import { AppNotification } from "../models/notification.model";
import { PushSubscription } from "../models/push-subscription.model";
import { User } from "../models/user.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { broadcast, getPreferences, listNotifications, putPreferences, subscribe, unsubscribe } from "./notifications.controller";

function fakeRes() {
  const res = { statusCode: 200, body: undefined as unknown, status(code: number) { res.statusCode = code; return res; }, json(body: unknown) { res.body = body; return res; }, end() { return res; } };
  return res;
}
const call = async (handler: (req: Request, res: Response) => unknown, req: Partial<Request>) => {
  const res = fakeRes();
  await handler(req as Request, res as unknown as Response);
  return res;
};

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("listNotifications", () => {
  test("without since returns nothing and the server time", async () => {
    await AppNotification.create({ type: "hint", title: "Nieuwe hint" });
    const res = await call(listNotifications, { query: {} });
    expect((res.body as { notifications: unknown[] }).notifications).toEqual([]);
    expect((res.body as { serverTime: Date }).serverTime).toBeInstanceOf(Date);
  });
  test("returns notifications after since, oldest first", async () => {
    // Relative to now: the feed only returns notifications up to the server time
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
    await AppNotification.create({ type: "hint", title: "oud", createdAt: at(60) });
    await AppNotification.create({ type: "hint", title: "b", createdAt: at(1) });
    await AppNotification.create({ type: "hint", title: "a", createdAt: at(2) });
    const res = await call(listNotifications, { query: { since: at(10).toISOString() } });
    expect((res.body as { notifications: { title: string }[] }).notifications.map((n) => n.title)).toEqual(["a", "b"]);
  });
});

describe("preferences", () => {
  test("defaults, update and promptedVersion never goes down", async () => {
    const user = await User.create({ email: "a@t.nl", password: "x", name: "A" });
    expect((await call(getPreferences, { user })).body).toEqual({ disabledTypes: [], promptedVersion: 0 });
    await call(putPreferences, { user, body: { disabledTypes: ["hint"], promptedVersion: 2 } });
    const res = await call(putPreferences, { user, body: { promptedVersion: 1 } });
    expect(res.body).toEqual({ disabledTypes: ["hint"], promptedVersion: 2 });
  });
});

describe("push subscriptions", () => {
  test("subscribe upserts by endpoint and moves it to the current user", async () => {
    const a = await User.create({ email: "a@t.nl", password: "x", name: "A" });
    const b = await User.create({ email: "b@t.nl", password: "x", name: "B" });
    const body = { endpoint: "https://push/1", keys: { p256dh: "p", auth: "a" } };
    await call(subscribe, { user: a, body, get: () => "UA" } as unknown as Partial<Request>);
    await call(subscribe, { user: b, body, get: () => "UA" } as unknown as Partial<Request>);
    const all = await PushSubscription.find().lean();
    expect(all).toHaveLength(1);
    expect(all[0].user.toString()).toBe(b._id.toString());
    await call(unsubscribe, { user: b, body: { endpoint: "https://push/1" } });
    expect(await PushSubscription.countDocuments()).toBe(0);
  });
});

test("broadcast stores an urgent notification", async () => {
  const admin = await User.create({ email: "h@t.nl", password: "x", name: "HQ", admin: true });
  const res = await call(broadcast, { user: admin, body: { message: "Terug naar HQ" } });
  expect(res.statusCode).toBe(201);
  expect(await AppNotification.findOne({ type: "broadcast" }).lean()).toMatchObject({ title: "Bericht van HQ", body: "Terug naar HQ", urgent: true });
});
