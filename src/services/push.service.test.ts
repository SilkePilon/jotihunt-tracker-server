import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import webpush from "web-push";
import { PushSubscription } from "../models/push-subscription.model";
import { User } from "../models/user.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { resetPushConfig, sendToAll, setPushSender } from "./push.service";

const silent = { error() {}, warn() {} };
const calls: string[] = [];

beforeAll(async () => {
  const keys = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  process.env.VAPID_SUBJECT = "mailto:test@test.nl";
  await connectTestDb();
});
beforeEach(async () => {
  await clearTestDb();
  calls.length = 0;
  resetPushConfig();
  setPushSender({
    async sendNotification(subscription) {
      calls.push(subscription.endpoint);
      if (subscription.endpoint.endsWith("/gone")) throw Object.assign(new Error("gone"), { statusCode: 410 });
      return {};
    },
  });
});
afterAll(async () => {
  setPushSender(null);
  await disconnectTestDb();
});

async function subscribe(name: string, endpoint: string, disabledTypes: string[] = []) {
  const user = await User.create({ email: `${name}@t.nl`, password: "x", name, notificationPrefs: { disabledTypes, promptedVersion: 0 } });
  await PushSubscription.create({ user: user._id, endpoint, keys: { p256dh: "p", auth: "a" } });
}

const notification = (type: "hint" | "broadcast") => ({ _id: "n1", type, title: "T", body: "B", urgent: false, data: {} });

describe("sendToAll", () => {
  test("skips users who disabled the type", async () => {
    await subscribe("a", "https://push/a");
    await subscribe("b", "https://push/b", ["hint"]);
    const result = await sendToAll(notification("hint"), silent);
    expect(calls).toEqual(["https://push/a"]);
    expect(result.sent).toBe(1);
  });
  test("broadcast reaches everyone", async () => {
    await subscribe("b", "https://push/b", ["hint", "broadcast"]);
    await sendToAll(notification("broadcast"), silent);
    expect(calls).toEqual(["https://push/b"]);
  });
  test("removes subscriptions the push service reports gone", async () => {
    await subscribe("a", "https://push/gone");
    const result = await sendToAll(notification("hint"), silent);
    expect(result.removed).toBe(1);
    expect(await PushSubscription.countDocuments()).toBe(0);
  });
  test("does nothing without VAPID keys", async () => {
    await subscribe("a", "https://push/a");
    const saved = process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    resetPushConfig();
    expect(await sendToAll(notification("hint"), silent)).toEqual({ sent: 0, removed: 0 });
    process.env.VAPID_PRIVATE_KEY = saved;
  });
});
