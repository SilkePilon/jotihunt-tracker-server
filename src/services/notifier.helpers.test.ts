import { describe, expect, test } from "bun:test";
import {
  buildArticleNotification,
  buildBroadcastNotification,
  buildCounterHuntNotification,
  COUNTER_HUNT_DIRECTIONS,
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
  test("window is 10 (inclusive) to 15 (exclusive) minutes", () => {
    expect(dueDeadlineWarnings([report(9.99)], now)).toHaveLength(0);
    expect(dueDeadlineWarnings([report(10)], now)).toHaveLength(1);
    expect(dueDeadlineWarnings([report(14.99)], now)).toHaveLength(1);
    expect(dueDeadlineWarnings([report(15)], now)).toHaveLength(0);
  });
  test("skips submitted, confirmed (on jotihunt.nl) and already warned reports", () => {
    const site = { status: "Goedgekeurd", points: 6, seenAt: now };
    expect(dueDeadlineWarnings([report(12, { submittedAt: now }), report(12, { deadlineWarnedAt: now }), report(12, { site })], now)).toHaveLength(0);
  });
  test("uses createdAt when the hunt time is unknown", () => {
    expect(dueDeadlineWarnings([{ huntTime: null, createdAt: new Date(now.getTime() - 12 * MIN) }], now)).toHaveLength(1);
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
  test("deadline of a photo report", () => {
    const notification = buildDeadlineNotification(
      { _id: "r1", area: "bravo", huntTime: new Date(now.getTime() - 10 * MIN), createdAt: now, reportedByName: "Sam", photo: "p.jpg" },
      now,
    );
    expect(notification).toMatchObject({
      type: "hunt-deadline",
      title: "Hunt Bravo moet over 5 min ingestuurd zijn",
      body: "Geregistreerd door Sam, nog niet ingestuurd.",
      data: { area: "bravo", huntReportId: "r1" },
    });
  });
  test("deadline of a hunt without a photo: confirm with the QR code", () => {
    const notification = buildDeadlineNotification({ _id: "r2", area: "charlie", huntTime: new Date(now.getTime() - 10 * MIN), createdAt: now, reportedByName: "Sam" }, now);
    expect(notification).toMatchObject({
      type: "hunt-deadline",
      title: "Bevestig hunt Charlie op jotihunt.nl, nog 5 min",
      body: "Gemeld door Sam.",
      data: { area: "charlie", huntReportId: "r2" },
    });
  });
  test("broadcast", () => {
    expect(buildBroadcastNotification("Terug naar HQ", "Kim")).toMatchObject({ type: "broadcast", urgent: true, title: "Bericht van HQ", body: "Terug naar HQ", data: { from: "Kim" } });
  });
});

describe("buildCounterHuntNotification", () => {
  test("writes the direction out with an arrow", () => {
    expect(buildCounterHuntNotification(45, "Kim")).toEqual({
      type: "counter-hunt",
      title: "Tegenhunt! Richting NO ↗",
      body: "Zoek de sticker binnen 500 m van het clubhuis, richting noordoost.",
      urgent: true,
      data: { direction: 45, from: "Kim" },
    });
    expect(buildCounterHuntNotification(270, "Kim").title).toBe("Tegenhunt! Richting W ←");
  });
  test("every direction has a label", () => {
    expect(COUNTER_HUNT_DIRECTIONS).toEqual([0, 45, 90, 135, 180, 225, 270, 315]);
    for (const direction of COUNTER_HUNT_DIRECTIONS) expect(buildCounterHuntNotification(direction, "x").title).not.toContain("undefined");
  });
  test("can be switched off", () => {
    expect(isTypeEnabled("counter-hunt", ["counter-hunt"])).toBe(false);
  });
});

test("isTypeEnabled: broadcast always on", () => {
  expect(isTypeEnabled("broadcast", ["broadcast"])).toBe(true);
  expect(isTypeEnabled("hint", ["hint"])).toBe(false);
  expect(isTypeEnabled("hint", [])).toBe(true);
});

describe("dueDeadlineWarnings with takenAt", () => {
  test("counts from the photo time when the sticker time is unknown", () => {
    const now = new Date("2026-10-17T14:30:00Z");
    const report = { huntTime: null, takenAt: new Date("2026-10-17T14:18:00Z"), createdAt: new Date("2026-10-17T14:27:00Z"), submittedAt: null, deadlineWarnedAt: null };
    expect(dueDeadlineWarnings([report], now)).toHaveLength(1); // 12 min after the photo, 3 min after the upload
  });
});
