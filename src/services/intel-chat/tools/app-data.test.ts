import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Area } from "../../../models/area.model";
import { Assignment, AssignmentStatus } from "../../../models/assignment.model";
import { User } from "../../../models/user.model";
import { Article } from "../../../models/article.model";
import { HintCell, HintCellStatus } from "../../../models/hint-cell.model";
import { Team } from "../../../models/team.model";
import { initHuntableAreas, resetHuntableAreas } from "../../../settings/huntable-areas-setting";
import { mockModel } from "../../../test/ai";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../../test/db";
import { runTool } from "../../../test/tools";
import { appDataTools } from "./app-data";

const NOW = new Date("2026-10-17T14:00:00Z");
const tools = appDataTools({ articleId: 10, now: () => NOW, toolModel: mockModel(() => "") });

const HINT_HTML = `<div>Intro van de hint</div><div>Alpha: <img src="https://cdn.jotihunt.net/a.png" alt="alpha.png"></div><div>Bravo: -</div>`;

async function seed() {
  await Article.create([
    { id: 10, title: "De Highland Games", type: "hint", publishAt: new Date("2026-10-17T13:00:00Z"), content: HINT_HTML, summary: "Hint over spelen" },
    { id: 11, title: "Bouw een kasteel", type: "assignment", publishAt: new Date("2026-10-17T12:00:00Z"), content: "<p>Bouw een <b>kasteel</b> van karton</p>", maxPoints: 12, endTime: new Date("2026-10-17T18:00:00Z") },
    { id: 12, title: "Happy hour", type: "news", publishAt: new Date("2026-10-17T11:00:00Z"), content: "<p>Om 15:00 begint het happy hour met dubbele punten</p>" },
    { id: 900001, title: "Testhint kasteel", type: "hint", publishAt: NOW, content: "<p>kasteel</p>" },
  ]);
  const slotTime = new Date("2026-10-17T13:00:00Z");
  await HintCell.create([
    { articleId: 10, area: "bravo", publishAt: slotTime, slotTime, status: HintCellStatus.None },
    { articleId: 10, area: "alpha", publishAt: slotTime, slotTime, status: HintCellStatus.Solved, answer: "1884 4407", answerKind: "rd", answerLocation: [5.87, 51.95], snippet: "<div>Alpha: plaatje</div>" },
    { articleId: 10, area: "charlie", publishAt: slotTime, slotTime, status: HintCellStatus.Open },
    { articleId: 900001, area: "alpha", publishAt: NOW, slotTime: NOW, status: HintCellStatus.Open },
  ]);
}

beforeAll(connectTestDb);
beforeEach(async () => {
  await clearTestDb();
  await seed();
});
afterEach(() => {
  resetHuntableAreas();
  delete process.env.HOME_TEAM_API_ID;
});
afterAll(disconnectTestDb);

describe("getItem", () => {
  test("the open item by default: text, kind, summary, images and hint cells in area order", async () => {
    const item = (await runTool(tools.getItem, {})) as Record<string, unknown> & { hintCells: { area: string; status: string; answer: string | null; location: unknown; snippet: string | null }[] };
    expect(item).toMatchObject({ articleId: 10, title: "De Highland Games", kind: "hint", summary: "Hint over spelen", images: [{ name: "alpha.png", url: "https://cdn.jotihunt.net/a.png" }], attachments: [] });
    expect(item.text).toBe("Intro van de hint\nAlpha: [afbeelding]\nBravo: -");
    expect(item.hintCells.map((cell) => [cell.area, cell.status, cell.answer])).toEqual([
      ["alpha", "solved", "1884 4407"],
      ["bravo", "none", null],
      ["charlie", "open", null],
    ]);
    expect(item.hintCells[0].location).toEqual({ lat: 51.95, lng: 5.87 });
    expect(item.hintCells[0].snippet).toBe("Alpha: plaatje");
  });

  test("another item by id; a hidden test hint or a missing id is an error", async () => {
    expect(await runTool(tools.getItem, { articleId: 11 })).toMatchObject({ kind: "opdracht", maxPoints: 12, endTime: "2026-10-17T18:00:00.000Z", hintCells: [] });
    expect(await runTool(tools.getItem, { articleId: 900001 })).toEqual({ error: "Item 900001 niet gevonden" });
    expect(await runTool(tools.getItem, { articleId: 5 })).toEqual({ error: "Item 5 niet gevonden" });
  });
});

describe("searchIntel", () => {
  test("case-insensitive in title and text, public items only, with a snippet", async () => {
    const { results } = (await runTool(tools.searchIntel, { query: "KASTEEL" })) as { results: { articleId: number; kind: string; snippet: string }[] };
    expect(results.map((result) => result.articleId)).toEqual([11]);
    expect(results[0]).toMatchObject({ kind: "opdracht", snippet: "Bouw een kasteel van karton" });
  });

  test("kind filter and a too short query", async () => {
    expect(((await runTool(tools.searchIntel, { query: "happy", kind: "hint" })) as { results: unknown[] }).results).toEqual([]);
    expect(((await runTool(tools.searchIntel, { query: "happy", kind: "nieuws" })) as { results: unknown[] }).results).toHaveLength(1);
    expect(await runTool(tools.searchIntel, { query: "a" })).toEqual({ error: "Zoekterm moet 2 tot 100 tekens zijn" });
  });

  test("regex characters are searched literally", async () => {
    expect(((await runTool(tools.searchIntel, { query: "(.*" })) as { results: unknown[] }).results).toEqual([]);
  });
});

describe("getHintBoard", () => {
  test("public cells with the article title; one area; unknown area is an error", async () => {
    const all = (await runTool(tools.getHintBoard, {})) as { cells: { articleTitle: string; area: string }[] };
    expect(all.cells).toHaveLength(3);
    expect(all.cells.every((cell) => cell.articleTitle === "De Highland Games")).toBe(true);
    const alpha = (await runTool(tools.getHintBoard, { area: "alpha" })) as { cells: { status: string; answer: string }[] };
    expect(alpha.cells).toEqual([expect.objectContaining({ status: "solved", answer: "1884 4407" })]);
    expect(await runTool(tools.getHintBoard, { area: "zulu" })).toEqual({ error: "Onbekend deelgebied: zulu" });
  });
});

describe("getAreas", () => {
  test("every area, status text, own area and the huntable setting", async () => {
    process.env.HOME_TEAM_API_ID = "7";
    await Team.create({ apiId: 7, name: "Onze groep", accomodation: "-", street: "-", houseNumber: 1, postCode: "1234AB", city: "-", area: "Charlie", location: { type: "Point", coordinates: [5.9, 52] } });
    await Area.create([
      { name: "Alpha", status: "green", updatedAt: NOW },
      { name: "Bravo", status: "red", updatedAt: NOW },
      { name: "Charlie", status: "orange", updatedAt: NOW },
    ]);
    await initHuntableAreas({ readHuntableAreas: async () => ({ key: "huntable-areas", areas: ["bravo"], updatedAt: NOW, updatedBy: null }), writeHuntableAreas: async () => {} });
    const overview = (await runTool(tools.getAreas, {})) as { ownArea: string; huntableConfigured: boolean; areas: Record<string, unknown>[] };
    expect(overview.ownArea).toBe("charlie");
    expect(overview.huntableConfigured).toBe(true);
    expect(overview.areas).toHaveLength(9);
    const byArea = Object.fromEntries(overview.areas.map((area) => [area.area, area]));
    expect(byArea.alpha).toMatchObject({ status: "green", statusText: "actief", allowed: false, huntableNow: false, own: false });
    expect(byArea.bravo).toMatchObject({ status: "red", statusText: "inactief", allowed: true, huntableNow: false });
    expect(byArea.charlie).toMatchObject({ status: "orange", statusText: "onderweg", allowed: true, huntableNow: true, own: true });
    expect(byArea.oscar).toMatchObject({ status: "unknown", statusText: "onbekend", allowed: false, updatedAt: null });
  });

  test("not configured: every area allowed", async () => {
    await Area.create({ name: "Alpha", status: "green", updatedAt: NOW });
    const overview = (await runTool(tools.getAreas, {})) as { ownArea: null; huntableConfigured: boolean; areas: { area: string; huntableNow: boolean; allowed: boolean }[] };
    expect(overview.ownArea).toBeNull();
    expect(overview.huntableConfigured).toBe(false);
    expect(overview.areas.every((area) => area.allowed)).toBe(true);
    expect(overview.areas.find((area) => area.area === "alpha")?.huntableNow).toBe(true);
  });
});

describe("getAssignment", () => {
  test("status, owner and notes with names; defaults when we never wrote anything", async () => {
    const assignment = appDataTools({ articleId: 11, now: () => NOW, toolModel: mockModel(() => "") });
    expect(await runTool(assignment.getAssignment, {})).toEqual({ articleId: 11, title: "Bouw een kasteel", status: "open", owner: null, notes: [], endTime: "2026-10-17T18:00:00.000Z", maxPoints: 12, site: null });
    const [anna, bram] = await User.create([{ name: "Anna" }, { name: "Bram" }]);
    await Assignment.create({
      articleId: 11,
      status: AssignmentStatus.Busy,
      owner: anna._id,
      notes: [
        { user: bram._id, text: "Karton gehaald", createdAt: new Date("2026-10-17T13:00:00Z") },
        { user: anna._id, text: "Foto volgt", createdAt: new Date("2026-10-17T13:30:00Z") },
      ],
    });
    expect(await runTool(tools.getAssignment, { articleId: 11 })).toMatchObject({
      status: "busy",
      owner: "Anna",
      notes: [
        { by: "Bram", text: "Karton gehaald", at: "2026-10-17T13:00:00.000Z" },
        { by: "Anna", text: "Foto volgt", at: "2026-10-17T13:30:00.000Z" },
      ],
    });
  });

  test("what jotihunt.nl showed, once checked", async () => {
    const checkedAt = new Date("2026-10-17T13:45:00Z");
    await Assignment.create({
      articleId: 11,
      status: AssignmentStatus.Submitted,
      statusBy: null,
      site: { submitted: true, imageUrl: "https://cdn.jotihunt.net/kasteel.jpg", rating: 4, judgement: "Nog niet beoordeeld", judged: false, points: null, checkedAt },
    });
    expect(await runTool(tools.getAssignment, { articleId: 11 })).toMatchObject({
      status: "submitted",
      site: { submitted: true, imageUrl: "https://cdn.jotihunt.net/kasteel.jpg", rating: 4, judgement: "Nog niet beoordeeld", judged: false, points: null, checkedAt: checkedAt.toISOString() },
    });
  });

  test("not an assignment or not found is an error", async () => {
    expect(await runTool(tools.getAssignment, {})).toEqual({ error: "Item 10 is geen opdracht" });
    expect(await runTool(tools.getAssignment, { articleId: 404 })).toEqual({ error: "Item 404 niet gevonden" });
  });
});
