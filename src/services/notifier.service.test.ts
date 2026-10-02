import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Area } from "../models/area.model";
import { Article } from "../models/article.model";
import { HuntReport } from "../models/hunt-report.model";
import { AppNotification } from "../models/notification.model";
import { NotifierState } from "../models/notifier-state.model";
import { User } from "../models/user.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { runNotifier } from "./notifier.service";

const MIN = 60 * 1000;
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

  test("deadline warning once", async () => {
    await run();
    const user = await User.create({ email: "s@t.nl", password: "x", name: "Sam" });
    await HuntReport.create({ area: "bravo", photo: "p.jpg", reportedBy: user._id, reportedByName: "Sam", huntTime: new Date(now.getTime() - 21 * MIN), createdAt: new Date(now.getTime() - 21 * MIN) });
    await HuntReport.create({ area: "alpha", photo: "q.jpg", reportedBy: user._id, reportedByName: "Sam", huntTime: new Date(now.getTime() - 21 * MIN), createdAt: new Date(now.getTime() - 21 * MIN), submittedAt: now });
    const created = await run();
    expect(created.map((notification) => notification.type)).toEqual(["hunt-deadline"]);
    expect(await run()).toHaveLength(0);
  });

  test("a failed insert releases the deadline claim so the next run warns", async () => {
    await run();
    const user = await User.create({ email: "s@t.nl", password: "x", name: "Sam" });
    const report = await HuntReport.create({ area: "bravo", photo: "p.jpg", reportedBy: user._id, reportedByName: "Sam", huntTime: new Date(now.getTime() - 21 * MIN), createdAt: new Date(now.getTime() - 21 * MIN) });
    const spy = spyOn(AppNotification, "insertMany").mockRejectedValueOnce(new Error("boom"));
    try {
      await expect(run()).rejects.toThrow("boom");
    } finally {
      spy.mockRestore();
    }
    expect((await HuntReport.findById(report._id))?.deadlineWarnedAt ?? null).toBeNull();
    const created = await run();
    expect(created.map((notification) => notification.type)).toEqual(["hunt-deadline"]);
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
});
