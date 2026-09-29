import { describe, expect, test } from "bun:test";
import { HintCellStatus, HintCheck } from "../../models/hint-cell.model";
import { huntReportStatus, needsReview } from "../../services/hunt-report.helpers";
import { DEMO_AREAS, HOUR_MS, OSCAR } from "./constants";
import { demoHuntStart } from "./articles";
import { HUNT_COOLDOWN_MS, planAreas, planHintCells, planHuntReports, planSpots } from "./plans";
import { createRng } from "./prng";

const now = new Date("2026-10-17T15:37:00Z");
const huntStart = demoHuntStart(now);

describe("area statuses", () => {
  test("6 green (incl. Oscar), 1 orange, 2 red, updated in the past", () => {
    const areas = planAreas(now, createRng(1));
    expect(areas.map((area) => area.name)).toEqual([...DEMO_AREAS]);
    const count = (status: string) => areas.filter((area) => area.status === status).length;
    expect([count("green"), count("orange"), count("red")]).toEqual([6, 1, 2]);
    expect(areas.find((area) => area.name === OSCAR)!.status).toBe("green");
    for (const area of areas) expect(area.updatedAt.getTime()).toBeLessThan(now.getTime());
  });
});

describe("hint cell states", () => {
  const hints = [0, 1, 2, 3, 4, 5].map((hour) => ({ articleId: 100 + hour, title: hour === 2 ? "Hint Oscar" : `Hint ${hour}`, slotTime: new Date(huntStart.getTime() + hour * HOUR_MS) }));
  const cells = hints.flatMap((hint) => DEMO_AREAS.map((area) => ({ articleId: hint.articleId, area: area.toLowerCase(), status: hint.articleId === 101 && area === "Bravo" ? "none" : "open" })));
  const plans = planHintCells({ hints, cells, redAreas: ["Charlie", "Golf"], now, userCount: 8, rng: createRng(3) });
  const of = (articleId: number) => plans.filter((plan) => plan.articleId === articleId);

  test("old hints are solved except 'none' cells; exactly one 'Twijfel', the rest 'Klopt'", () => {
    for (const articleId of [100, 101, 103]) {
      for (const plan of of(articleId)) expect(plan.status).toBe(articleId === 101 && plan.area === "bravo" ? HintCellStatus.None : HintCellStatus.Solved);
    }
    const checks = plans.filter((plan) => plan.articleId <= 103 && plan.status === HintCellStatus.Solved).map((plan) => plan.check);
    expect(checks.filter((check) => check === HintCheck.Disputed)).toHaveLength(1);
    expect(checks.filter((check) => check === HintCheck.Verified)).toHaveLength(checks.length - 1);
  });

  test("'Hint Oscar' only concerns Oscar", () => {
    expect(
      of(102)
        .filter((plan) => plan.status !== HintCellStatus.None)
        .map((plan) => plan.area),
    ).toEqual(["oscar"]);
  });

  test("the hint before the newest mixes solved and solving; the newest is open except one solving, red areas none", () => {
    const recent = of(104).map((plan) => plan.status);
    expect(recent.filter((status) => status === HintCellStatus.Solved).length).toBeGreaterThan(0);
    expect(recent.filter((status) => status === HintCellStatus.Solving).length).toBeGreaterThan(0);
    const newest = of(105);
    expect(newest.filter((plan) => plan.status === HintCellStatus.Solving)).toHaveLength(1);
    expect(newest.filter((plan) => plan.status === HintCellStatus.None).map((plan) => plan.area)).toEqual(["charlie", "golf"]);
    expect(newest.filter((plan) => plan.status === HintCellStatus.Open)).toHaveLength(6);
  });

  test("every hint has 1–3 notes; claims, checks and notes are consistent and never after now", () => {
    for (const hint of hints) {
      const notes = of(hint.articleId).reduce((sum, plan) => sum + plan.notes.length, 0);
      expect(notes).toBeGreaterThanOrEqual(1);
      expect(notes).toBeLessThanOrEqual(3);
    }
    for (const plan of plans) {
      if (plan.status === HintCellStatus.Solved || plan.status === HintCellStatus.Solving) {
        expect(plan.claimedBy).toBeDefined();
        expect(plan.claimedAt!.getTime()).toBeLessThanOrEqual(now.getTime());
      }
      if (plan.checkedBy !== undefined) expect(plan.checkedBy).not.toBe(plan.claimedBy);
      for (const note of plan.notes) expect(note.at.getTime()).toBeLessThanOrEqual(now.getTime());
    }
  });

  test("deterministic", () => {
    expect(planHintCells({ hints, cells, redAreas: ["Charlie", "Golf"], now, userCount: 8, rng: createRng(3) })).toEqual(plans);
  });
});

describe("hunt reports", () => {
  const areas = DEMO_AREAS.filter((area) => area !== "Charlie" && area !== "Golf");
  const plans = planHuntReports({ now, huntStart, areas: [...areas], userCount: 8, stickerCount: 10, rng: createRng(5) });

  test("status mix: 3 judged, 3 submitted, 3 to submit (1 needing review), 1 overdue", () => {
    const statuses = plans.map((plan) => huntReportStatus(plan, now));
    const count = (status: string) => statuses.filter((value) => value === status).length;
    expect([count("judged"), count("submitted"), count("to_submit"), count("overdue")]).toEqual([3, 3, 3, 1]);
    const review = plans.filter((plan) =>
      needsReview({
        huntCode: "x",
        huntTime: plan.huntTime,
        huntCodeSource: "ocr",
        huntTimeSource: "ocr",
        ocr: { status: "done", codeConfidence: plan.codeConfidence, timeConfidence: plan.timeConfidence },
      }),
    );
    expect(review.map((plan) => plan.kind)).toEqual(["review"]);
    expect(
      plans
        .filter((plan) => plan.site)
        .map((plan) => plan.site!.points)
        .sort(),
    ).toEqual([10, 10, 5].sort());
  });

  test("times between hunt start and now; different stickers; a fox is not hunted twice within the cooldown", () => {
    for (const plan of plans) {
      for (const time of [plan.huntTime, plan.createdAt, plan.submittedAt, plan.site?.seenAt]) {
        if (!time) continue;
        expect(time.getTime()).toBeLessThanOrEqual(now.getTime());
        expect(time.getTime()).toBeGreaterThanOrEqual(huntStart.getTime());
      }
      const sameArea = plans.filter((other) => other !== plan && other.area === plan.area);
      for (const other of sameArea) expect(Math.abs(other.huntTime.getTime() - plan.huntTime.getTime())).toBeGreaterThanOrEqual(HUNT_COOLDOWN_MS);
    }
    expect(new Set(plans.map((plan) => plan.sticker)).size).toBe(10);
  });

  test("spots are in the last 4 hours", () => {
    const spots = planSpots(now, [...areas], createRng(4));
    expect(spots).toHaveLength(4);
    for (const spot of spots) expect(now.getTime() - spot.time.getTime()).toBeLessThanOrEqual(4 * HOUR_MS);
  });
});
