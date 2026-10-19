import { getPosition, getTimes } from "suncalc";

const TIME_ZONE = "Europe/Amsterdam";
const HOUR_MS = 60 * 60 * 1000;

/** Amsterdam calendar date (YYYY-MM-DD) of a moment. */
function amsterdamDate(time: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(time);
}

/** Offset of Amsterdam from UTC at `time`, in ms. */
function amsterdamOffsetMs(time: Date): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, timeZoneName: "longOffset" })
    .formatToParts(time)
    .find((part) => part.type === "timeZoneName")?.value ?? "GMT+00:00";
  const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * HOUR_MS + Number(match[3] ?? 0) * 60_000);
}

/** The moment `hh:mm` Amsterdam time on Amsterdam date `date`. */
function amsterdamMoment(date: string, hh: number, mm: number): Date {
  const guess = new Date(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`);
  return new Date(guess.getTime() - amsterdamOffsetMs(guess));
}

/** Between sunset and sunrise at this place (by the sun times of that Amsterdam day). */
export function isNightAt(time: Date, lat: number, lng: number): boolean {
  const noon = amsterdamMoment(amsterdamDate(time), 12, 0);
  const { sunrise, sunset } = getTimes(noon, lat, lng);
  // No sunrise/sunset (polar day or night): go by the sun's height
  if (!sunrise || !sunset) return getPosition(time, lat, lng).altitude < 0;
  return time < sunrise || time >= sunset;
}

/** True when any part of [from, to] lies between sunset and sunrise. */
export function legIsNight(from: Date, to: Date, lat: number, lng: number): boolean {
  if (isNightAt(from, lat, lng) || isNightAt(to, lat, lng)) return true;
  // Both ends by day: night in between only when the leg spans a whole night (or more)
  return amsterdamDate(from) !== amsterdamDate(to);
}

/** Half of the game a moment belongs to: halves split at 23:00 Amsterdam (the fox team swap). */
export function amsterdamHalf(time: Date): string {
  return amsterdamDate(new Date(time.getTime() + HOUR_MS));
}

/** The 22:45-23:15 swap window that ends the half of `time` (all teams red, not a big move). */
export function swapWindow(time: Date): { start: Date; end: Date } {
  const half = amsterdamHalf(time);
  const previousDay = amsterdamDate(new Date(amsterdamMoment(half, 12, 0).getTime() - 24 * HOUR_MS));
  return { start: amsterdamMoment(previousDay, 22, 45), end: amsterdamMoment(previousDay, 23, 15) };
}
