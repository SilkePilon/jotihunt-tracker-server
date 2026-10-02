import { describe, expect, test } from "bun:test";
import {
  buildArticleNotification,
  buildBroadcastNotification,
  buildDeadlineNotification,
  buildFoxStatusNotification,
  diffAreaStatus,
  dueDeadlineWarnings,
  isTypeEnabled,
  newArticles,
} from "./notifier.helpers";

const MIN = 60 * 1000;
const now = new Date("2026-10-17T20:00:00Z");

describe("diffAreaStatus", () => {
  test("reports changed areas", () => {
    expect(diffAreaStatus({ Alpha: "red", Bravo: "red" }, [{ name: "Alpha", status: "green" }, { name: "Bravo", status: "red" }])).toEqual([
      { area: "Alpha", from: "red", to: "green" },
    ]);
  });
  test("ignores areas without a previous status and areas missing from the current read", () => {
    expect(diffAreaStatus({ Alpha: "red" }, [{ name: "Charlie", status: "green" }])).toEqual([]);
  });
});

describe("newArticles", () => {
  test("returns articles above the last id, sorted", () => {
    expect(newArticles([{ id: 5 }, { id: 3 }, { id: 7 }], 4).map((article) => article.id)).toEqual([5, 7]);
  });
});

describe("dueDeadlineWarnings", () => {
  const report = (minutesAgo: number, extra: object = {}) => ({ huntTime: new Date(now.getTime() - minutesAgo * MIN), createdAt: new Date(now.getTime() - minutesAgo * MIN), ...extra });
  test("window is 20 (inclusive) to 30 (exclusive) minutes", () => {
    expect(dueDeadlineWarnings([report(19.99)], now)).toHaveLength(0);
    expect(dueDeadlineWarnings([report(20)], now)).toHaveLength(1);
    expect(dueDeadlineWarnings([report(29.99)], now)).toHaveLength(1);
    expect(dueDeadlineWarnings([report(30)], now)).toHaveLength(0);
  });
  test("skips submitted and already warned reports", () => {
    expect(dueDeadlineWarnings([report(25, { submittedAt: now }), report(25, { deadlineWarnedAt: now })], now)).toHaveLength(0);
  });
  test("uses createdAt when the hunt time is unknown", () => {
    expect(dueDeadlineWarnings([{ huntTime: null, createdAt: new Date(now.getTime() - 22 * MIN) }], now)).toHaveLength(1);
  });
});

describe("builders", () => {
  test("to green is urgent", () => {
    const notification = buildFoxStatusNotification({ area: "alpha", from: "orange", to: "green" });
    expect(notification).toMatchObject({ type: "fox-status", urgent: true, title: "GROEN: Alpha — jagen mag!", data: { area: "alpha", status: "green", previousStatus: "orange" } });
  });
  test("other changes are not urgent", () => {
    expect(buildFoxStatusNotification({ area: "Bravo", from: "green", to: "red" })).toMatchObject({ urgent: false, title: "Bravo is nu rood", body: "Was groen." });
  });
  test("article types", () => {
    expect(buildArticleNotification({ id: 1, title: "Hint 3", type: "hint" })).toMatchObject({ type: "hint", title: "Nieuwe hint", body: "Hint 3" });
    expect(buildArticleNotification({ id: 2, title: "Foto", type: "assignment", endTime: new Date("2026-10-17T21:30:00Z") })).toMatchObject({
      type: "article",
      title: "Nieuwe opdracht",
      body: "Foto (deadline 23:30)",
    });
    expect(buildArticleNotification({ id: 3, title: "Info", type: "news" })).toMatchObject({ type: "article", title: "Nieuw bericht" });
  });
  test("deadline", () => {
    const notification = buildDeadlineNotification(
      { _id: "r1", area: "bravo", huntTime: new Date(now.getTime() - 20 * MIN), createdAt: now, reportedByName: "Sam" },
      now,
    );
    expect(notification).toMatchObject({ type: "hunt-deadline", title: "Hunt Bravo moet over 10 min ingestuurd zijn", data: { area: "bravo", huntReportId: "r1" } });
  });
  test("broadcast", () => {
    expect(buildBroadcastNotification("Terug naar HQ", "Kim")).toMatchObject({ type: "broadcast", urgent: true, title: "Bericht van HQ", body: "Terug naar HQ", data: { from: "Kim" } });
  });
});

test("isTypeEnabled: broadcast always on", () => {
  expect(isTypeEnabled("broadcast", ["broadcast"])).toBe(true);
  expect(isTypeEnabled("hint", ["hint"])).toBe(false);
  expect(isTypeEnabled("hint", [])).toBe(true);
});
