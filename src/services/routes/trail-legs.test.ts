import { describe, expect, test } from "bun:test";
import { classifyLegs, statusIntervals, type LegInput, type StatusEvent } from "./trail-legs";

const t = (hhmm: string, day = "2026-10-17") => new Date(`${day}T${hhmm}:00+02:00`);
const A: [number, number] = [5.911, 51.985];
const B: [number, number] = [5.95, 52.0];
let n = 0;
const leg = (from: Date, to: Date, walkMin: number | null, extra: Partial<LegInput> = {}): LegInput => ({
  fromId: `m${n}`, toId: `m${++n}`, from, to, fromCoord: A, toCoord: B, walkDurationS: walkMin === null ? null : walkMin * 60, ...extra,
});

describe("statusIntervals", () => {
  test("each event lasts until the next", () => {
    const events: StatusEvent[] = [{ status: "green", at: t("09:00") }, { status: "red", at: t("14:00") }, { status: "green", at: t("14:40") }];
    expect(statusIntervals(events, t("16:00")).map((i) => [i.status, i.from.toISOString(), i.to.toISOString()])).toEqual([
      ["green", t("09:00").toISOString(), t("14:00").toISOString()],
      ["red", t("14:00").toISOString(), t("14:40").toISOString()],
      ["green", t("14:40").toISOString(), t("16:00").toISOString()],
    ]);
  });
});

describe("classifyLegs", () => {
  test("plain walking leg", () => {
    const [l] = classifyLegs([leg(t("10:00"), t("11:00"), 40)], []);
    expect([l.mode, l.reason, l.night, l.manual]).toEqual(["walk", "walk", false, false]);
  });

  test("red overlap is the big move", () => {
    const events = [{ status: "green", at: t("09:00") }, { status: "red", at: t("14:05") }, { status: "green", at: t("14:35") }];
    const [l] = classifyLegs([leg(t("14:00"), t("14:40"), 30)], events);
    expect([l.mode, l.reason]).toEqual(["car", "status-red"]);
    expect(l.redFrom?.toISOString()).toBe(t("14:05").toISOString());
  });

  test("swap red is not a big move", () => {
    const events = [{ status: "green", at: t("20:00") }, { status: "red", at: t("22:45") }, { status: "green", at: t("23:15") }];
    const [l] = classifyLegs([leg(t("22:30"), t("23:30"), 50)], events);
    expect(l.mode).toBe("walk");
  });

  test("orange is an extra move", () => {
    const events = [{ status: "green", at: t("09:00") }, { status: "orange", at: t("15:10") }, { status: "green", at: t("15:30") }];
    const [l] = classifyLegs([leg(t("15:00"), t("15:45"), 30)], events);
    expect([l.mode, l.reason]).toEqual(["extra", "status-orange"]);
  });

  test("too fast to walk, only the worst per half", () => {
    const legs = [leg(t("10:00"), t("10:30"), 60), leg(t("11:00"), t("11:30"), 150), leg(t("12:00"), t("13:00"), 50)];
    const out = classifyLegs(legs, []);
    expect(out.map((l) => [l.mode, l.reason])).toEqual([["walk", "walk"], ["car", "too-fast"], ["walk", "walk"]]);
  });

  test("one per half: the second half gets its own", () => {
    const legs = [leg(t("10:00"), t("10:30"), 120), leg(t("10:00", "2026-10-18"), t("10:30", "2026-10-18"), 120)];
    expect(classifyLegs(legs, []).map((l) => l.mode)).toEqual(["car", "car"]);
  });

  test("red beats too-fast in the same half", () => {
    const events = [{ status: "green", at: t("09:00") }, { status: "red", at: t("15:00") }, { status: "green", at: t("15:20") }];
    const legs = [leg(t("10:00"), t("10:30"), 200), leg(t("14:50"), t("15:30"), 30)];
    expect(classifyLegs(legs, events).map((l) => [l.mode, l.reason])).toEqual([["walk", "walk"], ["car", "status-red"]]);
  });

  test("manual override wins and takes the half's big move", () => {
    const legs = [leg(t("10:00"), t("10:30"), 200), leg(t("12:00"), t("13:00"), 10, { override: "car" }), leg(t("14:00"), t("14:20"), 10, { override: "walk" })];
    expect(classifyLegs(legs, []).map((l) => [l.mode, l.reason, l.manual])).toEqual([
      ["walk", "walk", false], ["car", "manual", true], ["walk", "manual", true],
    ]);
  });

  test("night flag", () => {
    const [l] = classifyLegs([leg(t("20:00"), t("21:00"), 40)], []);
    expect(l.night).toBe(true);
  });

  test("unknown walking duration never triggers the speed check", () => {
    const [l] = classifyLegs([leg(t("10:00"), t("10:05"), null)], []);
    expect(l.mode).toBe("walk");
  });
});
