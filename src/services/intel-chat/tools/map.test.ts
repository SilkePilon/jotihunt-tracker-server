import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Article } from "../../../models/article.model";
import { HintCell, HintCellStatus } from "../../../models/hint-cell.model";
import { Team } from "../../../models/team.model";
import { mockModel } from "../../../test/ai";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../../test/db";
import { runTool } from "../../../test/tools";
import { Assignment } from "../../../models/assignment.model";
import { bearingBetween, parseCoordinate } from "../geo";
import { mapTools } from "./map";
import { normaliseAnswer, proposalTools } from "./proposals";

const NOW = new Date("2026-10-17T14:00:00Z");
const ctx = { articleId: 10, now: () => NOW, toolModel: mockModel(() => "") };
const tools = { ...mapTools(ctx), ...proposalTools(ctx) };

function team(apiId: number, name: string, area: string, rd: string) {
  const { lat, lng } = parseCoordinate(rd)!.latLng;
  return { apiId, name, accomodation: "-", street: "-", houseNumber: 1, postCode: "1234AB", city: "-", area, location: { type: "Point" as const, coordinates: [lng, lat] } };
}

beforeAll(connectTestDb);
beforeEach(async () => {
  await clearTestDb();
  await Team.create([team(1, "A1", "Alpha", "180000 440000"), team(2, "A2", "Alpha", "182500 440000"), team(3, "A3", "Alpha", "181000 442000"), team(4, "B1", "Bravo", "200000 440000")]);
  await Article.create([
    { id: 10, title: "Hint 10", type: "hint", publishAt: NOW, content: "x" },
    { id: 11, title: "Nieuws", type: "news", publishAt: NOW, content: "x" },
  ]);
  await HintCell.create({ articleId: 10, area: "alpha", publishAt: NOW, slotTime: NOW, status: HintCellStatus.Open });
});
afterAll(disconnectTestDb);

describe("convertCoordinates", () => {
  test("RD in, every notation out", async () => {
    expect(await runTool(tools.convertCoordinates, { input: "188362 440722" })).toMatchObject({ kind: "rd", rd: { x: 188362, y: 440722 }, formatted: { rd8: "1884 4407", rdFull: "188362 440722" }, insideNl: true });
  });

  test("unreadable input is an error the model can read", async () => {
    expect(await runTool(tools.convertCoordinates, { input: "geen idee" })).toEqual({ error: 'Kon geen coördinaat lezen uit input "geen idee"' });
  });
});

describe("checkPoint", () => {
  test("area estimate, nearest groups and no trackers in tests", async () => {
    const result = (await runTool(tools.checkPoint, { point: "181000 441000" })) as { point: { area: unknown; rdText: string }; nearestGroups: { name: string }[]; nearestTracker: unknown; insideNl: boolean };
    expect(result.point).toMatchObject({ rdText: "1810 4410", area: { area: "alpha", method: "hull" } });
    expect(result.nearestGroups.map((group) => group.name)).toEqual(["A3", "A1", "A2", "B1"]);
    expect(result.nearestTracker).toBeNull();
    expect(result.insideNl).toBe(true);
  });

  test("an unknown area is an error", async () => {
    expect(await runTool(tools.checkPoint, { point: "181000 441000", area: "zulu" })).toEqual({ error: "Onbekend deelgebied: zulu" });
  });
});

describe("nearbyGroups", () => {
  test("within the radius, clamped to 50..20000 m", async () => {
    const near = (await runTool(tools.nearbyGroups, { point: "181000 441000", radiusM: 1500 })) as { groups: { name: string }[] };
    expect(near).toEqual({ groups: [expect.objectContaining({ name: "A3", area: "alpha" }), expect.objectContaining({ name: "A1" })] });
    const wide = (await runTool(tools.nearbyGroups, { point: "181000 441000", radiusM: 999_999 })) as { groups: { name: string }[] };
    expect(wide.groups).toHaveLength(4);
    expect(((await runTool(tools.nearbyGroups, { point: "181000 441000", radiusM: 1 })) as { groups: unknown[] }).groups).toEqual([]);
  });
});

describe("showPoint", () => {
  test("a PointResult with the label", async () => {
    expect(await runTool(tools.showPoint, { point: "51.95392, 5.87252", label: "HQ" })).toMatchObject({ label: "HQ", rdText: "1884 4407", latLng: { lat: 51.95392, lng: 5.87252 } });
  });
});

describe("proposeHintAnswer", () => {
  test("an 8-digit RD answer stays as typed and gets a point", async () => {
    const proposal = (await runTool(tools.proposeHintAnswer, { area: "Alpha", answer: " 1810 4410 " })) as Record<string, unknown> & { point: { rdText: string; label: string } };
    expect(proposal).toMatchObject({ articleId: 10, area: "alpha", answer: "1810 4410", kind: "rd" });
    expect(proposal.point).toMatchObject({ rdText: "1810 4410", label: "Alpha: 1810 4410" });
  });

  test("another notation becomes the 8-digit RD answer; a word stays text", async () => {
    expect(await runTool(tools.proposeHintAnswer, { area: "alpha", answer: "51.95392, 5.87252" })).toMatchObject({ answer: "1884 4407", kind: "rd" });
    expect(await runTool(tools.proposeHintAnswer, { area: "alpha", answer: "Doedelzak" })).toMatchObject({ answer: "Doedelzak", kind: "text", point: null });
  });

  test("errors: unknown area, area without a cell, item not a hint, empty answer", async () => {
    expect(await runTool(tools.proposeHintAnswer, { area: "zulu", answer: "x" })).toEqual({ error: "Onbekend deelgebied: zulu" });
    expect(await runTool(tools.proposeHintAnswer, { area: "bravo", answer: "x" })).toEqual({ error: "Deze hint heeft geen vak voor Bravo" });
    expect(await runTool(proposalTools({ ...ctx, articleId: 11 }).proposeHintAnswer, { area: "alpha", answer: "x" })).toEqual({ error: "Het open item is geen hint" });
    expect(await runTool(tools.proposeHintAnswer, { area: "alpha", answer: "  " })).toEqual({ error: "Antwoord moet 1 tot 200 tekens zijn" });
  });

  test("normaliseAnswer keeps 6+6 RD as typed (parseRdAnswer reads it)", () => {
    expect(normaliseAnswer("188362 440722")).toMatchObject({ answer: "188362 440722", kind: "rd" });
  });
});

describe("intersect", () => {
  const latLng = (rd: string) => parseCoordinate(rd)!.latLng;
  const toward = (from: string) => bearingBetween(latLng(from), latLng("185000 445000"));

  test("two bearings: one PointResult with area and nearest group", async () => {
    const result = (await runTool(tools.intersect, { bearings: [{ from: "180000 440000", bearingDeg: toward("180000 440000") }, { from: "190000 440000", bearingDeg: toward("190000 440000") }] })) as {
      points: { label: string; rdText: string; nearestGroup: unknown }[];
    };
    expect(result.points).toHaveLength(1);
    expect(result.points[0]).toMatchObject({ label: "Snijpunt", rdText: "1850 4450", nearestGroup: expect.objectContaining({ name: "A3" }) });
  });

  test("two circles give two candidates; the centroid of points; a note when nothing meets", async () => {
    const two = (await runTool(tools.intersect, { circles: [{ center: "180000 440000", radiusM: 7071 }, { center: "190000 440000", radiusM: 7071 }] })) as { points: { label: string; rdText: string }[] };
    expect(two.points.map((point) => point.label)).toEqual(["Snijpunt 1", "Snijpunt 2"]);
    expect(two.points.map((point) => point.rdText).sort()).toEqual(["1850 4350", "1850 4450"]);
    expect(await runTool(tools.intersect, { points: ["180000 440000", "190000 440000"] })).toMatchObject({ points: [{ label: "Middelpunt", rdText: "1850 4400" }], note: "Middelpunt van 2 punten" });
    expect(await runTool(tools.intersect, { bearings: [{ from: "180000 440000", bearingDeg: 0 }, { from: "190000 440000", bearingDeg: 0 }] })).toEqual({ points: [], note: "De peilingen lopen evenwijdig; er is geen snijpunt" });
  });

  test("bad input is a Dutch error", async () => {
    expect(await runTool(tools.intersect, { bearings: [{ from: "180000 440000", bearingDeg: 10 }] })).toEqual({ error: "Geef minstens twee peilingen of cirkels, of alleen points (minstens twee) voor het middelpunt" });
    expect(await runTool(tools.intersect, { circles: [{ center: "180000 440000", radiusM: 0 }, { center: "190000 440000", radiusM: 10 }] })).toEqual({ error: "radiusM moet tussen 1 en 100000 liggen" });
    expect(await runTool(tools.intersect, { bearings: [{ from: "nergens", bearingDeg: 1 }, { from: "190000 440000", bearingDeg: 2 }] })).toEqual({ error: 'Kon geen coördinaat lezen uit from "nergens"' });
  });
});

describe("proposeAssignmentUpdate", () => {
  beforeEach(async () => {
    await Article.create({ id: 12, title: "Bouw een kasteel", type: "assignment", publishAt: NOW, content: "x" });
  });

  test("a proposal with status and/or note, nothing written", async () => {
    const assignment = proposalTools({ ...ctx, articleId: 12 });
    expect(await runTool(assignment.proposeAssignmentUpdate, { status: "busy", note: "  Foto staat op de drive " })).toEqual({ articleId: 12, title: "Bouw een kasteel", status: "busy", note: "Foto staat op de drive" });
    expect(await runTool(tools.proposeAssignmentUpdate, { articleId: 12, status: "submitted" })).toEqual({ articleId: 12, title: "Bouw een kasteel", status: "submitted" });
    expect(await Assignment.countDocuments()).toBe(0);
  });

  test("errors: not an assignment, bad status, nothing to change, note too long", async () => {
    expect(await runTool(tools.proposeAssignmentUpdate, { status: "busy" })).toEqual({ error: "Item 10 is geen opdracht" });
    expect(await runTool(tools.proposeAssignmentUpdate, { articleId: 99, status: "busy" })).toEqual({ error: "Item 99 niet gevonden" });
    expect(await runTool(tools.proposeAssignmentUpdate, { articleId: 12, status: "klaar" })).toEqual({ error: "Onbekende status: klaar (open, busy, submitted of skipped)" });
    expect(await runTool(tools.proposeAssignmentUpdate, { articleId: 12 })).toEqual({ error: "Geef een status of een notitie" });
    expect(await runTool(tools.proposeAssignmentUpdate, { articleId: 12, note: "x".repeat(1001) })).toEqual({ error: "Notitie moet 1 tot 1000 tekens zijn" });
  });
});
