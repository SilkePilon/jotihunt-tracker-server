import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Article } from "../../models/article.model";
import { HintCell, HintCellStatus } from "../../models/hint-cell.model";
import { Team } from "../../models/team.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../test/db";
import { setLife360Service, type Life360Service } from "../life360.service";
import { loadGroups, loadSolvedHintPoints, loadTrackers } from "./data";
import { parseCoordinate } from "./geo";
import { checkPointResult, pointResult } from "./point";

const NOW = new Date("2026-10-17T14:00:00Z");
const at = (rd: string) => {
  const { lat, lng } = parseCoordinate(rd)!.latLng;
  return { lat, lng };
};

function team(apiId: number, name: string, area: string | undefined, rd: string) {
  const { lat, lng } = at(rd);
  return { apiId, name, accomodation: "-", street: "-", houseNumber: 1, postCode: "1234AB", city: "-", area, location: { type: "Point" as const, coordinates: [lng, lat] } };
}

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterEach(() => setLife360Service(null));
afterAll(disconnectTestDb);

describe("loaders", () => {
  test("loadGroups lowercases known areas and keeps unknown as null", async () => {
    await Team.create([team(1, "Groep A", "Alpha", "180000 440000"), team(2, "Groep B", undefined, "190000 440000"), team(3, "Groep Z", "Zulu", "200000 440000")]);
    const groups = (await loadGroups()).sort((a, b) => a.name.localeCompare(b.name));
    expect(groups.map((group) => [group.name, group.area])).toEqual([
      ["Groep A", "alpha"],
      ["Groep B", null],
      ["Groep Z", null],
    ]);
    expect(groups[0].lat).toBeCloseTo(at("180000 440000").lat, 6);
  });

  test("loadSolvedHintPoints: solved RD cells of public hints, newest first, with the article title", async () => {
    await Article.create([
      { id: 1, title: "Hint 1", type: "hint", publishAt: NOW, content: "x" },
      { id: 2, title: "Hint 2", type: "hint", publishAt: NOW, content: "x" },
    ]);
    const cell = (articleId: number, area: string, hour: number, extra: Record<string, unknown>) =>
      HintCell.create({ articleId, area, publishAt: NOW, slotTime: new Date(`2026-10-17T${hour}:00:00Z`), ...extra });
    await cell(1, "alpha", 10, { status: HintCellStatus.Solved, answer: "1800 4400", answerKind: "rd", answerLocation: [5.8, 51.9] });
    await cell(2, "alpha", 11, { status: HintCellStatus.Solved, answer: "1810 4400", answerKind: "rd", answerLocation: [5.81, 51.9] });
    await cell(2, "bravo", 11, { status: HintCellStatus.Solved, answer: "kaas", answerKind: "text" });
    await cell(2, "charlie", 11, { status: HintCellStatus.Open });
    await cell(900001, "alpha", 12, { status: HintCellStatus.Solved, answer: "1820 4400", answerKind: "rd", answerLocation: [5.82, 51.9] });
    const points = await loadSolvedHintPoints();
    expect(points.map((point) => [point.articleTitle, point.area, point.lng])).toEqual([
      ["Hint 2", "alpha", 5.81],
      ["Hint 1", "alpha", 5.8],
    ]);
  });

  test("loadTrackers: Life360 members with a fix (Traccar is not configured in tests)", async () => {
    setLife360Service({
      members: () => ({
        linked: true,
        stale: false,
        members: [
          { id: "a", name: "Anna B.", initials: "AB", avatarUrl: null, location: { lat: 51.9, lon: 5.9, accuracyM: 10, at: "2026-10-17T13:50:00Z", driving: false, speedKmh: null, battery: null, charging: false } },
          { id: "b", name: "Bob C.", initials: "BC", avatarUrl: null, location: null },
        ],
      }),
    } as unknown as Life360Service);
    expect(await loadTrackers(NOW)).toEqual([{ name: "Anna B.", source: "life360", lat: 51.9, lng: 5.9, at: new Date("2026-10-17T13:50:00Z") }]);
  });
});

describe("pointResult / checkPointResult", () => {
  const groups = [
    { name: "A1", area: "alpha", ...at("180000 440000") },
    { name: "A2", area: "alpha", ...at("182500 440000") },
    { name: "A3", area: "alpha", ...at("181000 442000") },
    { name: "B1", area: "bravo", ...at("200000 440000") },
  ];

  test("pointResult: rounded RD, 8-digit text, area estimate and nearest group; empty label falls back to the RD text", () => {
    const point = pointResult(parseCoordinate("181000 441000")!, "  ", groups);
    expect(point.rd).toEqual({ x: 181000, y: 441000 });
    expect(point.rdText).toBe("1810 4410");
    expect(point.label).toBe("1810 4410");
    expect(point.area).toEqual({ area: "alpha", method: "hull" });
    expect(point.nearestGroup?.name).toBe("A3");
  });

  test("checkPointResult: 5 nearest groups, other hint points of the area without the current item, nearest tracker with age", () => {
    const hint = (articleId: number, area: string, rd: string) => ({ articleId, articleTitle: `Hint ${articleId}`, area, slotTime: new Date("2026-10-17T12:00:00Z"), ...at(rd) });
    const result = checkPointResult(parseCoordinate("181000 441000")!, {
      groups,
      hintPoints: [hint(7, "alpha", "181000 442000"), hint(8, "alpha", "181000 441000"), hint(9, "bravo", "200000 440000")],
      trackers: [
        { name: "Auto 1", source: "traccar", ...at("181000 443500"), at: new Date("2026-10-17T13:45:00Z") },
        { name: "Fiets", source: "traccar", ...at("181000 441100"), at: new Date("2026-10-17T13:58:00Z") },
      ],
      articleId: 8,
      now: NOW,
    });
    expect(result.nearestGroups.map((group) => group.name)).toEqual(["A3", "A1", "A2", "B1"]);
    expect(result.insideNl).toBe(true);
    expect(result.otherHintPoints).toEqual([{ articleTitle: "Hint 7", slotTime: "2026-10-17T12:00:00.000Z", distanceM: expect.any(Number) }]);
    expect(Math.abs(result.otherHintPoints[0].distanceM - 1000)).toBeLessThan(15);
    expect(result.nearestTracker).toEqual({ name: "Fiets", distanceM: expect.any(Number), ageMin: 2 });
  });

  test("an explicit area wins over the estimate", () => {
    const result = checkPointResult(parseCoordinate("181000 440500")!, { groups, hintPoints: [{ articleId: 9, articleTitle: "Hint 9", area: "bravo", slotTime: NOW, ...at("200000 440000") }], trackers: [], area: "bravo", articleId: 1, now: NOW });
    expect(result.otherHintPoints).toHaveLength(1);
    expect(result.nearestTracker).toBeNull();
  });
});
