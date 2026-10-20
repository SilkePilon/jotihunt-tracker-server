import { describe, expect, test } from "bun:test";
import {
  buildArticleNotification,
  buildBroadcastNotification,
  buildCounterHuntNotification,
  COUNTER_HUNT_DIRECTIONS,
  buildFoxStatusNotification,
  buildHuntCooldownNotification,
  buildHuntSyncNotification,
  diffAreaStatus,
  huntCooldownReady,
  isTypeEnabled,
  newArticles,
  OPTIONAL_NOTIFICATION_TYPES,
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
  test("to blue: travelling by OV, not urgent; from blue reads met OV", () => {
    expect(buildFoxStatusNotification({ area: "oscar", from: "red", to: "blue" })).toMatchObject({
      urgent: false,
      title: "OV: Oscar reist met OV — niet hunten",
      body: "Was rood.",
      data: { area: "oscar", status: "blue", previousStatus: "red" },
    });
    expect(buildFoxStatusNotification({ area: "Oscar", from: "blue", to: "red" })).toMatchObject({ title: "Oscar is nu rood", body: "Was met OV." });
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

describe("huntCooldownReady", () => {
  const now = new Date("2026-10-17T20:00:00Z");
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const hunt = (area: string, minutesAgo: number) => ({ area, huntTime: ago(minutesAgo) });

  test("not seeded: records every last hunt, announces nothing", () => {
    const result = huntCooldownReady({ lastHunts: [hunt("alpha", 70)], status: { Alpha: "green" }, notified: undefined, now });
    expect(result.ready).toEqual([]);
    expect(result.notified).toEqual({ alpha: ago(70).toISOString() });
  });

  test("announces once the hour is over and the fox is green or orange", () => {
    const result = huntCooldownReady({ lastHunts: [hunt("alpha", 61), hunt("bravo", 65)], status: { Alpha: "green", Bravo: "orange" }, notified: {}, now });
    expect(result.ready).toEqual([
      { area: "alpha", status: "green", huntTime: ago(61) },
      { area: "bravo", status: "orange", huntTime: ago(65) },
    ]);
    expect(result.notified).toEqual({ alpha: ago(61).toISOString(), bravo: ago(65).toISOString() });
  });

  test("still in cooldown: nothing, not recorded", () => {
    const result = huntCooldownReady({ lastHunts: [hunt("alpha", 59)], status: { Alpha: "green" }, notified: {}, now });
    expect(result.ready).toEqual([]);
    expect(result.notified).toEqual({});
  });

  test("red or blue: waits without recording", () => {
    for (const status of ["red", "blue"]) {
      const result = huntCooldownReady({ lastHunts: [hunt("alpha", 90)], status: { Alpha: status }, notified: {}, now });
      expect(result.ready).toEqual([]);
      expect(result.notified).toEqual({});
    }
  });

  test("already announced for this hunt: nothing", () => {
    const result = huntCooldownReady({ lastHunts: [hunt("alpha", 90)], status: { Alpha: "green" }, notified: { alpha: ago(90).toISOString() }, now });
    expect(result.ready).toEqual([]);
  });

  test("a newer hunt re-arms the area", () => {
    const result = huntCooldownReady({ lastHunts: [hunt("alpha", 61)], status: { Alpha: "green" }, notified: { alpha: ago(200).toISOString() }, now });
    expect(result.ready).toHaveLength(1);
  });

  test("cooldown ended more than 2 hours ago: recorded without announcing", () => {
    const result = huntCooldownReady({ lastHunts: [hunt("alpha", 181)], status: { Alpha: "green" }, notified: {}, now });
    expect(result.ready).toEqual([]);
    expect(result.notified).toEqual({ alpha: ago(181).toISOString() });
  });

  test("keeps entries of areas without a last hunt; unknown status waits", () => {
    const result = huntCooldownReady({ lastHunts: [hunt("charlie", 70)], status: {}, notified: { alpha: "2026-10-17T10:00:00.000Z" }, now });
    expect(result.ready).toEqual([]);
    expect(result.notified).toEqual({ alpha: "2026-10-17T10:00:00.000Z" });
  });
});

describe("buildHuntCooldownNotification", () => {
  test("title, body, quiet", () => {
    const notification = buildHuntCooldownNotification({ area: "alpha", status: "green", huntTime: new Date("2026-10-17T12:05:00Z") });
    expect(notification).toEqual({
      type: "hunt-cooldown",
      title: "Alpha mag weer gehunt worden",
      body: "Groen · laatste hunt 14:05",
      urgent: false,
      data: { area: "alpha", status: "green", huntTime: "2026-10-17T12:05:00.000Z" },
    });
    expect(buildHuntCooldownNotification({ area: "bravo", status: "orange", huntTime: new Date("2026-10-17T12:05:00Z") }).body).toBe("Oranje · laatste hunt 14:05");
  });

  test("hunt-cooldown can be switched off", () => {
    expect(OPTIONAL_NOTIFICATION_TYPES).toContain("hunt-cooldown");
  });
});
