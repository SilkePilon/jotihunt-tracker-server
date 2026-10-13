import { describe, expect, test } from "bun:test";
import { buildHappyHourNotification, happyHourView, overlaps, parseHappyHourWindow } from "./happy-hour.helpers";

// 20:45 in Amsterdam (CEST, UTC+2)
const received = new Date("2026-10-17T18:45:00Z");
const window = (startsAt: string, endsAt: string, parsed = true) => ({ startsAt: new Date(startsAt), endsAt: new Date(endsAt), parsed });

describe("parseHappyHourWindow", () => {
  test("both times", () => {
    const expected = window("2026-10-17T19:00:00Z", "2026-10-17T20:00:00Z");
    expect(parseHappyHourWindow("Happy hour van 21:00 tot 22:00!", received)).toEqual(expected);
    expect(parseHappyHourWindow("Happy hour 21:00 - 22:00", received)).toEqual(expected);
    expect(parseHappyHourWindow("Happy hour 21.00–22.00", received)).toEqual(expected);
    expect(parseHappyHourWindow("Happy hour tussen 21 en 22 uur", received)).toEqual(expected);
    expect(parseHappyHourWindow("Happy hour van 21 tot 22 uur", received)).toEqual(expected);
    expect(parseHappyHourWindow("Happy hour van 21:30 tot 22:15", received)).toEqual(window("2026-10-17T19:30:00Z", "2026-10-17T20:15:00Z"));
  });
  test("only an end: starts on receipt", () => {
    const expected = window("2026-10-17T18:45:00Z", "2026-10-17T20:00:00Z");
    expect(parseHappyHourWindow("Het is happy hour tot 22:00", received)).toEqual(expected);
    expect(parseHappyHourWindow("Het is happy hour tot 22 uur", received)).toEqual(expected);
  });
  test("only a start: lasts an hour", () => {
    const expected = window("2026-10-17T19:00:00Z", "2026-10-17T20:00:00Z");
    expect(parseHappyHourWindow("Happy hour om 21:00", received)).toEqual(expected);
    expect(parseHappyHourWindow("Happy hour vanaf 21.00 uur", received)).toEqual(expected);
    expect(parseHappyHourWindow("Happy hour om 21 uur", received)).toEqual(expected);
  });
  test("no times: the coming hour, not parsed", () => {
    expect(parseHappyHourWindow("Het komende uur is het happy hour!", received)).toEqual(window("2026-10-17T18:45:00Z", "2026-10-17T19:45:00Z", false));
    expect(parseHappyHourWindow("Happy hour!", received)).toEqual(window("2026-10-17T18:45:00Z", "2026-10-17T19:45:00Z", false));
  });
  test("around midnight", () => {
    // 23:30 in Amsterdam
    const late = new Date("2026-10-17T21:30:00Z");
    expect(parseHappyHourWindow("van 00:00 tot 01:00", late)).toEqual(window("2026-10-17T22:00:00Z", "2026-10-17T23:00:00Z"));
    expect(parseHappyHourWindow("van 23:30 tot 00:30", late)).toEqual(window("2026-10-17T21:30:00Z", "2026-10-17T22:30:00Z"));
    // More than an hour before receipt: tomorrow
    expect(parseHappyHourWindow("om 22:00", late)).toEqual(window("2026-10-18T20:00:00Z", "2026-10-18T21:00:00Z"));
    // Less than an hour before: today (already running)
    expect(parseHappyHourWindow("om 22:45", late)).toEqual(window("2026-10-17T20:45:00Z", "2026-10-17T21:45:00Z"));
  });
  test("winter time", () => {
    expect(parseHappyHourWindow("van 21:00 tot 22:00", new Date("2026-12-01T19:00:00Z"))).toEqual(window("2026-12-01T20:00:00Z", "2026-12-01T21:00:00Z"));
  });
  test("numbers that are no time are ignored", () => {
    expect(parseHappyHourWindow("Happy hour! 2x punten, om 25:00", received).parsed).toBe(false);
  });
});

describe("overlaps", () => {
  test("touching windows don't overlap", () => {
    const a = window("2026-10-17T19:00:00Z", "2026-10-17T20:00:00Z");
    expect(overlaps(a, window("2026-10-17T19:30:00Z", "2026-10-17T20:30:00Z"))).toBe(true);
    expect(overlaps(a, window("2026-10-17T20:00:00Z", "2026-10-17T21:00:00Z"))).toBe(false);
  });
});

describe("buildHappyHourNotification", () => {
  const hour = { _id: "h1", ...window("2026-10-17T19:00:00Z", "2026-10-17T20:00:00Z") };
  test("announce: later or now", () => {
    expect(buildHappyHourNotification("announce", hour, received)).toEqual({
      type: "happy-hour",
      title: "Happy hour! Hunts tellen dubbel",
      body: "Van 21:00 tot 22:00. Tegenhunts tellen niet mee.",
      urgent: true,
      data: { phase: "announce", happyHourId: "h1", startsAt: "2026-10-17T19:00:00.000Z", endsAt: "2026-10-17T20:00:00.000Z" },
    });
    expect(buildHappyHourNotification("announce", hour, new Date("2026-10-17T19:00:00Z")).body).toBe("Vanaf nu tot 22:00. Tegenhunts tellen niet mee.");
  });
  test("start and a silent end", () => {
    expect(buildHappyHourNotification("start", hour, received)).toMatchObject({ title: "Happy hour begint nu", body: "Hunts tellen dubbel tot 22:00.", urgent: true });
    expect(buildHappyHourNotification("end", hour, received)).toMatchObject({ title: "Happy hour voorbij", body: "Hunts tellen weer normaal.", urgent: false, data: { phase: "end", silent: true } });
  });
});

describe("happyHourView", () => {
  const hour = { ...window("2026-10-17T19:00:00Z", "2026-10-17T20:00:00Z"), text: "Happy hour!" };
  test("upcoming, active, ended", () => {
    const base = { startsAt: "2026-10-17T19:00:00.000Z", endsAt: "2026-10-17T20:00:00.000Z", text: "Happy hour!" };
    expect(happyHourView(hour, received)).toEqual({ state: "upcoming", ...base });
    expect(happyHourView(hour, new Date("2026-10-17T19:00:00Z"))).toEqual({ state: "active", ...base });
    expect(happyHourView(hour, new Date("2026-10-17T20:00:00Z"))).toEqual({ state: "none" });
    expect(happyHourView(null, received)).toEqual({ state: "none" });
  });
});
