import { describe, expect, test } from "bun:test";
import {
  buildArticleNotification,
  buildBroadcastNotification,
  buildCounterHuntNotification,
  COUNTER_HUNT_DIRECTIONS,
  buildFoxStatusNotification,
  buildHuntSyncNotification,
  diffAreaStatus,
  isTypeEnabled,
  newArticles,
} from "./notifier.helpers";

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
  test("hunt sync events", () => {
    const base = { _id: "e1", huntId: "h1", area: "alpha" };
    expect(buildHuntSyncNotification({ ...base, type: "new", huntTime: new Date("2026-10-17T19:43:00Z") })).toEqual({
      type: "hunt-new",
      title: "Hunt Alpha binnengekomen",
      body: "Geregistreerd om 21:43, wacht op beoordeling.",
      urgent: false,
      data: { area: "alpha", huntId: "h1", eventId: "e1" },
    });
    expect(buildHuntSyncNotification({ ...base, type: "approved", points: 10 })).toMatchObject({ type: "hunt-approved", title: "Hunt Alpha goedgekeurd · +10", data: { points: 10 } });
    expect(buildHuntSyncNotification({ ...base, area: "echo", type: "rejected" })).toMatchObject({ type: "hunt-rejected", title: "Hunt Echo afgekeurd" });
    expect(buildHuntSyncNotification({ ...base, type: "points", points: 15 })).toBeNull();
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
