import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Area } from "../models/area.model";
import { AreaStatusEvent } from "../models/area-status-event.model";
import { Article } from "../models/article.model";
import { HintCell, HintCellStatus } from "../models/hint-cell.model";
import { Hunt } from "../models/hunt.model";
import { Marker, MarkerType } from "../models/marker.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { areaHistory, statusPeriods } from "./area-history.service";

const at = (hhmm: string) => new Date(`2026-10-17T${hhmm}:00Z`);
const from = at("15:00"),
  to = at("18:00");

describe("statusPeriods", () => {
  test("event before the window is clipped to from; equal statuses merge; last runs", () => {
    expect(
      statusPeriods({
        before: { status: "green", at: at("12:00") },
        events: [
          { status: "green", at: at("15:30") },
          { status: "red", at: at("16:00") },
        ],
        current: null,
        from,
        to,
      }),
    ).toEqual([
      { status: "green", from, to: at("16:00") },
      { status: "red", from: at("16:00"), to: null },
    ]);
  });
  test("no events at all, area unchanged since before the window: one period of the current status", () => {
    expect(statusPeriods({ before: null, events: [], current: { status: "orange", updatedAt: at("10:00") }, from, to })).toEqual([{ status: "orange", from, to: null }]);
  });
  test("no event before the window: lane starts at the first event", () => {
    expect(statusPeriods({ before: null, events: [{ status: "red", at: at("16:00") }], current: { status: "red", updatedAt: at("16:00") }, from, to })).toEqual([
      { status: "red", from: at("16:00"), to: null },
    ]);
  });
  test("no events, area changed inside the window: current status from updatedAt", () => {
    expect(statusPeriods({ before: null, events: [], current: { status: "green", updatedAt: at("17:00") }, from, to })).toEqual([{ status: "green", from: at("17:00"), to: null }]);
  });
  test("unknown statuses are skipped", () => {
    expect(statusPeriods({ before: { status: "weird", at: at("12:00") }, events: [{ status: "green", at: at("16:00") }], current: null, from, to })).toEqual([
      { status: "green", from: at("16:00"), to: null },
    ]);
  });
});

/** Alpha red since 16:00 with hints, spots and hunts around the window 15:00-18:00 (and things that must stay out). */
async function seedAlphaHistory() {
  const point = { type: "Point" as const, coordinates: [5.9, 52.0] };
  const cell = (articleId: number, area: string, status: HintCellStatus, publishAt: Date, solvedAt?: Date) => ({
    articleId,
    area,
    status,
    publishAt,
    slotTime: publishAt,
    ...(solvedAt ? { solvedAt } : {}),
  });
  const hunt = (area: string, huntTime: Date, statusClass: "approved" | "rejected" | "unknown" | undefined, statusText = "Goedgekeurd") => ({
    area,
    huntTime,
    statusClass,
    status: statusText,
    statusText,
    points: 0,
    updatedAt: huntTime,
  });
  await Promise.all([
    Area.create([
      { name: "Alpha", status: "red", updatedAt: at("16:00") },
      { name: "Bravo", status: "green", updatedAt: at("10:00") },
    ]),
    AreaStatusEvent.create([
      { area: "Alpha", status: "green", at: at("12:00") },
      { area: "Alpha", status: "red", at: at("16:00") },
      { area: "Bravo", status: "orange", at: at("16:30") },
    ]),
    Article.create({ id: 1, title: "Hint 19:00", type: "hint", publishAt: at("17:00"), content: "x" }),
    HintCell.create([
      cell(1, "alpha", HintCellStatus.Open, at("17:00")),
      cell(2, "alpha", HintCellStatus.None, at("17:00")),
      cell(3, "alpha", HintCellStatus.Solved, at("15:30"), at("16:10")),
      cell(4, "alpha", HintCellStatus.Solved, at("13:00"), at("14:00")), // solved before the window
      cell(6, "alpha", HintCellStatus.Solved, at("16:00")), // solved, time unknown: left out
      cell(5, "alpha", HintCellStatus.Open, at("10:00")), // stale: published long before the window
      cell(1, "bravo", HintCellStatus.Open, at("17:00")),
    ]),
    Marker.create([
      { area: "alpha", type: MarkerType.Spot, time: at("17:30"), location: point },
      { area: "Alpha", type: MarkerType.Spot, time: at("14:55"), location: point },
      { area: "alpha", type: MarkerType.Spot, time: at("14:40"), location: point }, // before the 10 min lead
      { area: "alpha", type: MarkerType.Hint, time: at("16:00"), location: point },
      { area: "bravo", type: MarkerType.Spot, time: at("17:00"), location: point },
    ]),
    Hunt.create([
      hunt("alpha", at("16:30"), "approved"),
      hunt("alpha", at("17:10"), "rejected", "Afgekeurd"),
      hunt("alpha", at("17:20"), "approved", "Tegenhunt goedgekeurd"),
      hunt("Alpha", at("14:30"), "unknown", "Iets anders"),
      hunt("alpha", at("15:40"), undefined, "Wacht op bevestiging"),
      hunt("alpha", at("13:30"), "approved"), // cooldown over before the window
      hunt("bravo", at("17:00"), "approved"),
    ]),
  ]);
}

describe("areaHistory", () => {
  beforeAll(connectTestDb);
  beforeEach(clearTestDb);
  afterAll(disconnectTestDb);

  test("status, hints, spots and hunts of one area in the window", async () => {
    await seedAlphaHistory();
    const history = await areaHistory("alpha", 180, to);
    expect(history).toEqual({
      area: "alpha",
      from: from.toISOString(),
      to: to.toISOString(),
      status: [
        { status: "green", from: from.toISOString(), to: at("16:00").toISOString() },
        { status: "red", from: at("16:00").toISOString(), to: null },
      ],
      hints: [
        { articleId: 3, publishAt: at("15:30").toISOString(), solvedAt: at("16:10").toISOString(), title: "Hint 17:30" },
        { articleId: 1, publishAt: at("17:00").toISOString(), solvedAt: null, title: "Hint 19:00" },
      ],
      spots: [
        { id: expect.any(String), at: at("14:55").toISOString() },
        { id: expect.any(String), at: at("17:30").toISOString() },
      ],
      hunts: [
        { id: expect.any(String), at: at("14:30").toISOString(), result: "pending" },
        { id: expect.any(String), at: at("15:40").toISOString(), result: "pending" },
        { id: expect.any(String), at: at("16:30").toISOString(), result: "approved" },
        { id: expect.any(String), at: at("17:10").toISOString(), result: "rejected" },
      ],
    });
  });

  test("an area missing from the database: null", async () => {
    await seedAlphaHistory();
    expect(await areaHistory("charlie", 180, to)).toBeNull();
  });

  test("no status event at or before the window: the current status from from when unchanged since", async () => {
    await Area.create({ name: "Bravo", status: "green", updatedAt: at("10:00") });
    expect((await areaHistory("bravo", 180, to))?.status).toEqual([{ status: "green", from: from.toISOString(), to: null }]);
  });
});
