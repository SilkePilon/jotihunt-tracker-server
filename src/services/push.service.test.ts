import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import webpush from "web-push";
import { PushSubscription } from "../models/push-subscription.model";
import { User } from "../models/user.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { resetPushConfig, sendToAll, setPushDeadline, setPushSender } from "./push.service";

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
  const user = await User.create({ name, notificationPrefs: { disabledTypes, promptedVersion: 0 } });
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
  test("failed push logs no raw error (endpoint is a secret)", async () => {
    setPushSender({
      async sendNotification() {
        throw Object.assign(new Error("boom"), { statusCode: 500, body: "x".repeat(500), endpoint: "https://push/secret-token" });
      },
    });
    await subscribe("a", "https://push/secret-token");
    const logged: unknown[][] = [];
    await sendToAll(notification("hint"), { error: (...args) => void logged.push(args), warn() {} });
    expect(logged).toHaveLength(1);
    expect(logged[0][1]).toEqual({ statusCode: 500, message: "boom", body: "x".repeat(200) });
    expect(JSON.stringify(logged)).not.toContain("secret-token");
  });
  test("a hanging push service does not block the batch: deadline, and web-push gets a timeout", async () => {
    const options: unknown[] = [];
    setPushSender({
      async sendNotification(subscription, _payload, requestOptions) {
        options.push(requestOptions);
        if (subscription.endpoint.endsWith("/hang")) return new Promise(() => {});
        return {};
      },
    });
    setPushDeadline(200);
    try {
      await subscribe("a", "https://push/hang");
      await subscribe("b", "https://push/b");
      const logged: unknown[][] = [];
      const started = Date.now();
      const result = await sendToAll(notification("hint"), { error: (...args) => void logged.push(args), warn() {} });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(result).toEqual({ sent: 1, removed: 0 });
      expect(logged).toHaveLength(1);
      expect(options.every((option) => (option as { timeout?: number }).timeout === 10_000)).toBe(true);
    } finally {
      setPushDeadline(15_000);
    }
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
    try {
      delete process.env.VAPID_PRIVATE_KEY;
      resetPushConfig();
      expect(await sendToAll(notification("hint"), silent)).toEqual({ sent: 0, removed: 0 });
    } finally {
      process.env.VAPID_PRIVATE_KEY = saved;
      resetPushConfig();
    }
  });
  test("resolves without sending when the VAPID keys are invalid", async () => {
    await subscribe("a", "https://push/a");
    const saved = process.env.VAPID_PUBLIC_KEY;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      process.env.VAPID_PUBLIC_KEY = "not-a-key";
      resetPushConfig();
      expect(await sendToAll(notification("hint"), silent)).toEqual({ sent: 0, removed: 0 });
      expect(calls).toEqual([]);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
      process.env.VAPID_PUBLIC_KEY = saved;
      resetPushConfig();
    }
  });
  test("a malformed endpoint does not stop the batch", async () => {
    await subscribe("a", "not a url/fail");
    await subscribe("b", "https://push/b");
    setPushSender({
      async sendNotification(subscription) {
        if (subscription.endpoint.endsWith("/fail")) throw new Error("boom");
        calls.push(subscription.endpoint);
        return {};
      },
    });
    const result = await sendToAll(notification("hint"), silent);
    expect(result.sent).toBe(1);
    expect(calls).toEqual(["https://push/b"]);
  });
});
