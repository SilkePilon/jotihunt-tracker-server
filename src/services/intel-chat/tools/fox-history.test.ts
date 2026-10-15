import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import mongoose from "mongoose";
import { Article } from "../../../models/article.model";
import { HintCell, HintCellStatus } from "../../../models/hint-cell.model";
import { Hunt } from "../../../models/hunt.model";
import { HuntReport } from "../../../models/hunt-report.model";
import { Prediction } from "../../../models/prediction.model";
import { setLife360Service, type Life360Service } from "../../life360.service";
import { mockModel } from "../../../test/ai";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../../../test/db";
import { runTool } from "../../../test/tools";
import { appDataTools } from "./app-data";

const NOW = new Date("2026-10-17T15:00:00Z");
const tools = appDataTools({ articleId: 10, now: () => NOW, toolModel: mockModel(() => "") });

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterEach(() => setLife360Service(null));
afterAll(disconnectTestDb);

describe("getFoxHistory", () => {
  test("hunts, hunt reports and solved hints of the area, oldest first, plus the prediction", async () => {
    await Article.create({ id: 10, title: "Hint 10", type: "hint", publishAt: NOW, content: "x" });
    await Hunt.create([
      { area: "Alpha", huntCode: "A1", status: "goedgekeurd", points: 6, huntTime: new Date("2026-10-17T13:00:00Z"), updatedAt: NOW },
      { area: "Bravo", huntCode: "B1", status: "goedgekeurd", points: 3, huntTime: new Date("2026-10-17T13:00:00Z"), updatedAt: NOW },
    ]);
    await HuntReport.create({ area: "alpha", photo: "p.jpg", reportedBy: new mongoose.Types.ObjectId(), reportedByName: "Anna", huntTime: new Date("2026-10-17T14:00:00Z"), location: { type: "Point", coordinates: [5.87252, 51.95392] } });
    await HintCell.create({ articleId: 10, area: "alpha", publishAt: NOW, slotTime: new Date("2026-10-17T12:00:00Z"), status: HintCellStatus.Solved, answer: "1884 4407", answerKind: "rd", answerLocation: [5.87252, 51.95392] });
    await Prediction.create({ area: "alpha", status: "ok", updatedAt: NOW, pin: { lat: 52, lng: 5.9 }, confidence: "medium", why: "loopt naar het oosten" });
    const history = (await runTool(tools.getFoxHistory, { area: "Alpha" })) as { area: string; events: { kind: string; detail: string; rdText: string | null }[]; prediction: Record<string, unknown> };
    expect(history.area).toBe("alpha");
    expect(history.events.map((event) => event.kind)).toEqual(["hint", "hunt", "hunt-report"]);
    expect(history.events[0]).toMatchObject({ detail: 'hint "Hint 10": 1884 4407', rdText: "1884 4407" });
    expect(history.events[1]).toMatchObject({ detail: "hunt op jotihunt.nl: goedgekeurd, 6 punten", rdText: null });
    expect(history.events[2]).toMatchObject({ detail: "hunt gemeld door Anna", rdText: "1884 4407" });
    expect(history.prediction).toMatchObject({ pin: { lat: 52, lng: 5.9 }, confidence: "medium", why: "loopt naar het oosten" });
  });

  test("unknown area is an error; an area without anything is empty", async () => {
    expect(await runTool(tools.getFoxHistory, { area: "zulu" })).toEqual({ error: "Onbekend deelgebied: zulu" });
    expect(await runTool(tools.getFoxHistory, { area: "oscar" })).toEqual({ area: "oscar", events: [], prediction: null });
  });
});

describe("getOurTeams", () => {
  test("Life360 members with position, RD and age (Traccar is not configured in tests)", async () => {
    setLife360Service({
      members: () => ({
        linked: true,
        stale: false,
        members: [{ id: "a", name: "Anna B.", initials: "AB", avatarUrl: null, location: { lat: 51.95392, lon: 5.87252, accuracyM: 10, at: "2026-10-17T14:50:00Z", driving: false, speedKmh: null, battery: null, charging: false } }],
      }),
    } as unknown as Life360Service);
    expect(await runTool(tools.getOurTeams, {})).toEqual({ trackers: [{ name: "Anna B.", source: "life360", latLng: { lat: 51.95392, lng: 5.87252 }, rdText: "1884 4407", ageMin: 10 }] });
  });
});
