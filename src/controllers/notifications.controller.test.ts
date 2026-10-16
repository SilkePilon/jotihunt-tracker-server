import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Request, Response } from "express";
import { AppNotification } from "../models/notification.model";
import { PushSubscription } from "../models/push-subscription.model";
import { User } from "../models/user.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { broadcast, dropRemovedNotificationTypes, getCounterHunt, getPreferences, listNotifications, putPreferences, subscribe, unsubscribe } from "./notifications.controller";

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
    const user = await User.create({ name: "A" });
    expect((await call(getPreferences, { user })).body).toEqual({ disabledTypes: [], promptedVersion: 0 });
    await call(putPreferences, { user, body: { disabledTypes: ["hint"], promptedVersion: 2 } });
    const res = await call(putPreferences, { user, body: { promptedVersion: 1 } });
    expect(res.body).toEqual({ disabledTypes: ["hint"], promptedVersion: 2 });
  });

  test("removed types (hunt-deadline) are never shown, dropped on save and pulled at startup", async () => {
    const user = await User.create({ name: "A", notificationPrefs: { disabledTypes: ["hunt-deadline", "hint"] } });
    expect((await call(getPreferences, { user })).body).toEqual({ disabledTypes: ["hint"], promptedVersion: 0 });
    const res = await call(putPreferences, { user, body: { disabledTypes: ["hunt-deadline", "article", "nonsense"] } });
    expect(res.body).toEqual({ disabledTypes: ["article"], promptedVersion: 0 });

    const other = await User.create({ name: "B", notificationPrefs: { disabledTypes: ["hunt-deadline", "fox-status"] } });
    expect(await dropRemovedNotificationTypes()).toBe(1);
    expect((await User.findById(other._id).lean())?.notificationPrefs?.disabledTypes).toEqual(["fox-status"]);
  });
});

describe("push subscriptions", () => {
  test("subscribe upserts by endpoint and moves it to the current user", async () => {
    const a = await User.create({ name: "A" });
    const b = await User.create({ name: "B" });
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
  const admin = await User.create({ name: "HQ", admin: true });
  const res = await call(broadcast, { user: admin, body: { message: "Terug naar HQ" } });
  expect(res.statusCode).toBe(201);
  expect(await AppNotification.findOne({ type: "broadcast" }).lean()).toMatchObject({ title: "Bericht van HQ", body: "Terug naar HQ", urgent: true });
});

describe("getCounterHunt", () => {
  test("nothing yet", async () => {
    expect((await call(getCounterHunt, {})).body).toEqual({ active: false });
  });
  test("the latest counter-hunt notification, active for 30 minutes from its start", async () => {
    const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await AppNotification.create({ type: "counter-hunt", title: "oud", data: { direction: 90 }, createdAt: new Date(Date.now() - 60 * 60_000) });
    await AppNotification.create({ type: "counter-hunt", title: "Tegenhunt!", data: { direction: null, text: "Tegenhunt!", startedAt } });
    expect((await call(getCounterHunt, {})).body).toMatchObject({ active: true, direction: null, startedAt, text: "Tegenhunt!" });
  });
});
