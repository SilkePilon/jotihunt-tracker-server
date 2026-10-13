import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { HappyHour } from "../models/happy-hour.model";
import { AppNotification } from "../models/notification.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { currentHappyHour, HappyHourService } from "./happy-hour.service";

// 20:45 in Amsterdam; "van 21:00 tot 22:00" is 19:00Z-20:00Z
const RECEIVED = new Date("2026-10-17T18:45:00Z");
const START = new Date("2026-10-17T19:00:00Z");
const END = new Date("2026-10-17T20:00:00Z");

/** A clock that runs at real speed from a chosen moment, so short real timers reach the scheduled times */
let offset = 0;
const setNow = (at: Date) => (offset = at.getTime() - Date.now());
const now = () => new Date(Date.now() + offset);

let service: HappyHourService;
const message = (telegramId: number, text: string, date = RECEIVED) => ({ telegramId, text, date });
const titles = async () => (await AppNotification.find().sort({ createdAt: 1 }).lean()).map((notification) => notification.title);
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out");
};

beforeAll(connectTestDb);
beforeEach(async () => {
  await clearTestDb();
  setNow(RECEIVED);
  service = new HappyHourService({ logger: { info() {}, warn() {}, error() {} }, now, retryWaitMs: 5 });
});
afterEach(() => service.stop());
afterAll(disconnectTestDb);

describe("HappyHourService", () => {
  test("announce, start and a silent end, each once", async () => {
    await service.handleMessage(message(1, "Happy hour van 21:00 tot 22:00"));
    expect(await AppNotification.findOne().lean()).toMatchObject({ type: "happy-hour", title: "Happy hour! Hunts tellen dubbel", body: "Van 21:00 tot 22:00. Tegenhunts tellen niet mee.", urgent: true });
    expect(await currentHappyHour(now())).toEqual({ state: "upcoming", startsAt: START.toISOString(), endsAt: END.toISOString(), text: "Happy hour van 21:00 tot 22:00" });

    setNow(new Date(START.getTime() - 30));
    await service.rebuild();
    await until(async () => (await AppNotification.countDocuments()) === 2);
    expect(await currentHappyHour(now())).toMatchObject({ state: "active" });

    setNow(new Date(END.getTime() - 30));
    await service.rebuild();
    await until(async () => (await AppNotification.countDocuments()) === 3);
    expect(await titles()).toEqual(["Happy hour! Hunts tellen dubbel", "Happy hour begint nu", "Happy hour voorbij"]);
    expect(await AppNotification.findOne({ title: "Happy hour voorbij" }).lean()).toMatchObject({ urgent: false, data: { phase: "end", silent: true } });
    expect(await currentHappyHour(now())).toEqual({ state: "none" });

    // Nothing left to fire
    await service.rebuild();
    await Bun.sleep(30);
    expect(await AppNotification.countDocuments()).toBe(3);
  });

  test("starting now: the announcement is the start alert", async () => {
    await service.handleMessage(message(1, "Het is happy hour tot 22:00"));
    expect(await AppNotification.findOne().lean()).toMatchObject({ body: "Vanaf nu tot 22:00. Tegenhunts tellen niet mee." });
    setNow(new Date(END.getTime() - 30));
    await service.rebuild();
    await until(async () => (await AppNotification.countDocuments()) === 2);
    expect(await titles()).toEqual(["Happy hour! Hunts tellen dubbel", "Happy hour voorbij"]);
  });

  test("an overlapping message updates the window without a new alert; a known message is skipped", async () => {
    await service.handleMessage(message(1, "Happy hour van 21:00 tot 22:00"));
    await service.handleMessage(message(1, "Happy hour van 21:00 tot 22:00"));
    await service.handleMessage(message(2, "Happy hour verlengd tot 22:30", new Date("2026-10-17T19:10:00Z")));
    expect(await AppNotification.countDocuments()).toBe(1);
    const hours = await HappyHour.find().lean();
    expect(hours).toHaveLength(1);
    expect(hours[0]).toMatchObject({ telegramIds: [1, 2], text: "Happy hour verlengd tot 22:30" });
    expect(hours[0].endsAt.toISOString()).toBe("2026-10-17T20:30:00.000Z");
  });

  test("a window that already ended (read late) is stored without alerts", async () => {
    setNow(new Date("2026-10-17T23:00:00Z"));
    await service.handleMessage(message(1, "Happy hour van 21:00 tot 22:00"));
    await service.rebuild();
    await Bun.sleep(30);
    expect(await AppNotification.countDocuments()).toBe(0);
    expect(await HappyHour.countDocuments()).toBe(1);
  });

  test("an end alert long after the end (server was down) is skipped", async () => {
    await service.handleMessage(message(1, "Het is happy hour tot 22:00"));
    setNow(new Date(END.getTime() + 60 * 60_000));
    await service.rebuild();
    await until(async () => (await HappyHour.findOne().lean())?.endNotifiedAt != null);
    expect(await AppNotification.countDocuments()).toBe(1);
  });

  test("a message without times never changes a known window, only records its id", async () => {
    await service.handleMessage(message(1, "Happy hour van 21:00 tot 22:00"));
    // Before the start (so no start alert fires during the test)
    setNow(new Date("2026-10-17T18:50:00Z"));
    await service.handleMessage(message(2, "Happy hour is begonnen!", new Date("2026-10-17T18:50:00Z")));
    await service.handleMessage(message(3, "Happy hour is voorbij", new Date("2026-10-17T18:55:00Z")));
    const hours = await HappyHour.find().lean();
    expect(hours).toHaveLength(1);
    expect(hours[0]).toMatchObject({ telegramIds: [1, 2, 3], text: "Happy hour van 21:00 tot 22:00" });
    expect(hours[0].startsAt.toISOString()).toBe(START.toISOString());
    expect(hours[0].endsAt.toISOString()).toBe(END.toISOString());
    expect(await AppNotification.countDocuments()).toBe(1);
  });

  test("an end message never creates a window; a start without times does (the coming hour)", async () => {
    await service.handleMessage(message(1, "Happy hour is afgelopen"));
    expect(await HappyHour.countDocuments()).toBe(0);
    expect(await AppNotification.countDocuments()).toBe(0);
    await service.handleMessage(message(2, "Happy hour is begonnen!"));
    expect(await HappyHour.findOne().lean()).toMatchObject({ parsed: false, telegramIds: [2] });
    expect(await AppNotification.findOne().lean()).toMatchObject({ body: "Vanaf nu tot 21:45. Tegenhunts tellen niet mee." });
  });

  test("a failing write is reported to the caller (so the message is retried)", async () => {
    const failing = new HappyHourService({ logger: { info() {}, warn() {}, error() {} }, now, retryWaitMs: 1, attempts: 0 });
    await expect(failing.handleMessage(message(1, "Happy hour van 21:00 tot 22:00"))).rejects.toThrow();
  });
});
