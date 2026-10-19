import { describe, expect, test } from "bun:test";
import { amsterdamHalf, isNightAt, legIsNight, swapWindow } from "./sun";

const ARNHEM = { lat: 51.985, lng: 5.911 };
// 17 Oct 2026, Arnhem: sunrise ~08:10, sunset ~18:45 local (CEST, UTC+2)
const local = (hhmm: string, day = "2026-10-17") => new Date(`${day}T${hhmm}:00+02:00`);

describe("sun", () => {
  test("night before sunrise and after sunset", () => {
    expect(isNightAt(local("06:00"), ARNHEM.lat, ARNHEM.lng)).toBe(true);
    expect(isNightAt(local("12:00"), ARNHEM.lat, ARNHEM.lng)).toBe(false);
    expect(isNightAt(local("21:00"), ARNHEM.lat, ARNHEM.lng)).toBe(true);
  });

  test("a leg is night when any part of it is", () => {
    expect(legIsNight(local("17:30"), local("19:30"), ARNHEM.lat, ARNHEM.lng)).toBe(true);
    expect(legIsNight(local("10:00"), local("15:00"), ARNHEM.lat, ARNHEM.lng)).toBe(false);
    expect(legIsNight(local("07:00"), local("09:00"), ARNHEM.lat, ARNHEM.lng)).toBe(true);
  });

  test("halves split at 23:00 Amsterdam", () => {
    expect(amsterdamHalf(local("22:59"))).toBe("2026-10-17");
    expect(amsterdamHalf(local("23:00"))).toBe("2026-10-18");
    expect(amsterdamHalf(local("10:00", "2026-10-18"))).toBe("2026-10-18");
  });

  test("swap window 22:45-23:15 at the start of the half", () => {
    const w = swapWindow(local("23:10"));
    expect(w.start.toISOString()).toBe(local("22:45").toISOString());
    expect(w.end.toISOString()).toBe(local("23:15").toISOString());
    expect(swapWindow(local("09:00", "2026-10-18")).start.toISOString()).toBe(local("22:45").toISOString());
  });
});
