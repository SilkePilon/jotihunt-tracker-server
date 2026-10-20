import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Area } from "../models/area.model";
import { Article } from "../models/article.model";
import { AppNotification } from "../models/notification.model";
import { NotifierState } from "../models/notifier-state.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { runNotifier } from "./notifier.service";

const now = new Date("2026-10-17T20:00:00Z");
const sent: string[] = [];
const run = (at = now) => runNotifier({ now: at, send: async (notification) => void sent.push(notification.title) });

beforeAll(connectTestDb);
beforeEach(async () => {
  await clearTestDb();
  sent.length = 0;
});
afterAll(disconnectTestDb);

async function setAreas(statuses: Record<string, string>) {
  await Area.deleteMany({});
  await Area.insertMany(Object.entries(statuses).map(([name, status]) => ({ name, status, updatedAt: now })));
}

describe("runNotifier", () => {
  test("first run only records state", async () => {
    await setAreas({ Alpha: "red" });
    await Article.create({ id: 1, title: "Hint 1", type: "hint", publishAt: now, content: "x" });
    expect(await run()).toHaveLength(0);
    const state = await NotifierState.findOne();
    expect(state?.initialized).toBe(true);
    expect(state?.lastArticleId).toBe(1);
  });

  test("status change, new article, sent once", async () => {
    await setAreas({ Alpha: "red", Bravo: "red" });
    await run();
    await setAreas({ Alpha: "green", Bravo: "red" });
    await Article.create({ id: 2, title: "Nieuws", type: "news", publishAt: now, content: "x" });
    const created = await run();
    expect(created.map((notification) => notification.title)).toEqual(["GROEN: Alpha — jagen mag!", "Nieuw bericht"]);
    expect(sent).toHaveLength(2);
    expect(await run()).toHaveLength(0);
    expect(await AppNotification.countDocuments()).toBe(2);
  });

  test("seeded articles (id >= 900000) are not announced and do not block real ones", async () => {
    await setAreas({ Alpha: "red" });
    await Article.create({ id: 900001, title: "Seed", type: "hint", publishAt: now, content: "x" });
    await run();
    expect((await NotifierState.findOne())?.lastArticleId).toBe(0);
    await Article.create({ id: 900002, title: "Seed 2", type: "hint", publishAt: now, content: "x" });
    expect(await run()).toHaveLength(0);
    await Article.create({ id: 5, title: "Echt", type: "news", publishAt: now, content: "x" });
    expect(await run()).toHaveLength(1);
    expect((await NotifierState.findOne())?.lastArticleId).toBe(5);
  });

  test("announces at most the newest 3 new articles but advances past all", async () => {
    await run();
    for (let id = 1; id <= 5; id++) await Article.create({ id, title: `A${id}`, type: "news", publishAt: now, content: "x" });
    expect(await run()).toHaveLength(3);
    expect((await NotifierState.findOne())?.lastArticleId).toBe(5);
    expect(await run()).toHaveLength(0);
  });

  test("a partial area read does not forget statuses", async () => {
    await setAreas({ Alpha: "red", Bravo: "red" });
    await run();
    await setAreas({ Alpha: "red" });
    await run();
    await setAreas({ Alpha: "red", Bravo: "green" });
    expect((await run()).map((notification) => notification.data.area)).toEqual(["Bravo"]);
  });

  test("a failing push does not fail the run", async () => {
    await setAreas({ Alpha: "red" });
    await run();
    await setAreas({ Alpha: "green" });
    const errors: string[] = [];
    const created = await runNotifier({
      now,
      send: () => Promise.reject(new Error("push down")),
      log: { error: (message) => void errors.push(message) },
    });
    expect(created).toHaveLength(1);
    expect(await AppNotification.countDocuments()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(errors).toHaveLength(1);
    expect(await run()).toHaveLength(0);
  });

  test("overlapping first runs store the state once and do not fail", async () => {
    await setAreas({ Alpha: "red" });
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => run()));
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await NotifierState.countDocuments()).toBe(1);
    expect((await NotifierState.findOne())?.initialized).toBe(true);
  });

  test("overlapping runs announce a fox status change and a new article once", async () => {
    await setAreas({ Alpha: "red", Bravo: "red" });
    await run();
    for (let round = 0; round < 10; round++) {
      await setAreas({ Alpha: round % 2 ? "red" : "green", Bravo: "red" });
      await Article.create({ id: round + 1, title: `A${round}`, type: "news", publishAt: now, content: "x" });
      sent.length = 0;
      await AppNotification.deleteMany({});
      const created = await Promise.all([run(), run(), run()]);
      expect(created.flat().map((notification) => notification.type).sort()).toEqual(["article", "fox-status"]);
      expect(await AppNotification.countDocuments()).toBe(2);
      expect(sent).toHaveLength(2);
    }
  });

  test("a failed insert rolls the state back so the next run announces the change", async () => {
    await setAreas({ Alpha: "red" });
    await run();
    await setAreas({ Alpha: "green" });
    const spy = spyOn(AppNotification, "insertMany").mockRejectedValueOnce(new Error("boom"));
    try {
      await expect(run()).rejects.toThrow("boom");
    } finally {
      spy.mockRestore();
    }
    expect((await run()).map((notification) => notification.type)).toEqual(["fox-status"]);
    expect(await run()).toHaveLength(0);
  });

  test("a state without a version (older documents) still works", async () => {
    await setAreas({ Alpha: "red" });
    await NotifierState.collection.insertOne({ key: "notifier", areaStatus: { Alpha: "red" }, lastArticleId: 0, initialized: true });
    await setAreas({ Alpha: "green" });
    expect(await run()).toHaveLength(1);
    expect(await run()).toHaveLength(0);
  });

  test("a hanging push stops counting as running work", async () => {
    const { activeWorkCount } = await import("../editions/work-tracking");
    await setAreas({ Alpha: "red" });
    await run();
    await setAreas({ Alpha: "green" });
    const errors: string[] = [];
    const before = activeWorkCount();
    await runNotifier({ now, send: () => new Promise(() => {}), log: { error: (message) => void errors.push(message) }, pushTrackLimitMs: 50 });
    expect(activeWorkCount()).toBe(before + 1);
    await Bun.sleep(100);
    expect(activeWorkCount()).toBe(before);
    expect(errors).toEqual(["Pushing a notification failed"]);
  });
});
