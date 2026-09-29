import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import { Area } from "../../models/area.model";
import { Article } from "../../models/article.model";
import { HintCell, HintCellStatus, HintCheck } from "../../models/hint-cell.model";
import { Hunt } from "../../models/hunt.model";
import { HuntReport } from "../../models/hunt-report.model";
import { Marker, MarkerType } from "../../models/marker.model";
import { Team } from "../../models/team.model";
import { TransitStop } from "../../models/transit-stop.model";
import { User } from "../../models/user.model";
import { listHuntReports } from "../../services/hunt-report.service";
import { demoUploadsDir } from "../../services/photo-store";
import { parseRdAnswer } from "../../services/rd-answer";
import { closeDemoMode, initDemoMode, mongoUriDbName, switchDemoMode } from "../database-switch";
import { installDemoWorld } from "../demo-world";
import { getSimulation, simulatedPositions } from "../simulated-trackers";
import { DEMO_HUNTERS } from "./constants";
import { createRng } from "./prng";

/** A test-only "real" database next to MONGO_URI_TEST (never the real jotihunt database). */
const baseUri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
const realName = `${mongoUriDbName(baseUri)}-demoworld`;
const realUri = baseUri.replace(/^(mongodb(?:\+srv)?:\/\/[^/?#]*)(?:\/[^?#]*)?/, `$1/${realName}`);

let uploads: string;
let previousUploads: string | undefined;

/** 8 blobs of 5 groups plus 4 central groups, some with a logo */
function seedTeams() {
  const rng = createRng(9);
  const teams = [];
  let apiId = 1;
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 4; col++) {
      for (let i = 0; i < 5; i++) teams.push({ lng: 5.4 + col * 0.3 + rng.range(-0.04, 0.04), lat: 52.3 - row * 0.3 + rng.range(-0.04, 0.04) });
    }
  }
  for (let i = 0; i < 4; i++) teams.push({ lng: 5.85 + rng.range(-0.01, 0.01), lat: 52.15 + rng.range(-0.01, 0.01) });
  return teams.map(({ lng, lat }) => {
    const id = apiId++;
    return {
      apiId: id,
      name: `Groep ${id}`,
      accomodation: "Clubhuis",
      street: "Straat",
      houseNumber: id,
      postCode: "1234AB",
      city: "Stad",
      location: { type: "Point", coordinates: [lng, lat] },
      ...(id % 3 === 0 ? { logoUrl: `https://cdn.example/logo-${id}.jpg` } : {}),
    };
  });
}

async function withRealDb<T>(fn: (db: mongoose.Connection) => Promise<T>): Promise<T> {
  const connection = await mongoose.createConnection(realUri).asPromise();
  try {
    return await fn(connection);
  } finally {
    await connection.close();
  }
}

beforeAll(async () => {
  previousUploads = process.env.UPLOADS_DIR;
  uploads = await mkdtemp(path.join(tmpdir(), "demo-world-"));
  process.env.UPLOADS_DIR = uploads;
  await withRealDb(async (db) => {
    await db.dropDatabase();
    await db.collection("teams").insertMany(seedTeams());
    await db.collection("transitstops").insertMany([
      { osmId: 1, name: "Station Midden", kind: "train", location: { type: "Point", coordinates: [5.85, 52.15] } },
      { osmId: 2, name: "Bushalte Noord", kind: "bus", location: { type: "Point", coordinates: [5.5, 52.3] } },
    ]);
    await db.collection("users").insertOne({ email: "hq@test.nl", password: "x", name: "HQ", admin: true, requiresPasswordChange: false });
  });
  installDemoWorld();
  await initDemoMode(realUri);
});

afterAll(async () => {
  await closeDemoMode();
  await withRealDb(async (db) => {
    await db.dropDatabase();
    await db.useDb(`${realName}-demo`, { useCache: false }).dropDatabase();
  });
  if (previousUploads === undefined) delete process.env.UPLOADS_DIR;
  else process.env.UPLOADS_DIR = previousUploads;
  await rm(uploads, { recursive: true, force: true });
});

describe("demo world generator (full run)", () => {
  test("switching on fills the demo database; switching off leaves the real one untouched", async () => {
    const before = Date.now();
    await switchDemoMode(true);
    const now = new Date();

    // Areas, teams with areas and logos, transit stops
    expect(await Area.countDocuments()).toBe(9);
    const areaStatuses = (await Area.find().lean()).map((area) => area.status);
    expect(areaStatuses.filter((status) => status === "red")).toHaveLength(2);
    expect(await Team.countDocuments()).toBe(44);
    expect(await Team.countDocuments({ area: null })).toBe(0);
    expect(await Team.countDocuments({ area: "Oscar" })).toBe(4);
    expect(new Set(await Team.distinct("area")).size).toBe(9);
    expect(await Team.countDocuments({ logoUrl: { $exists: true } })).toBe(14);
    expect(await TransitStop.countDocuments()).toBe(2);

    // Articles and hint cells
    expect(await Article.countDocuments()).toBe(15);
    expect(await Article.countDocuments({ type: "hint" })).toBe(6);
    expect(await Article.countDocuments({ publishAt: { $gt: now } })).toBe(0);
    expect(await HintCell.countDocuments()).toBe(54);
    const solved = await HintCell.find({ status: HintCellStatus.Solved }).lean();
    expect(solved.length).toBeGreaterThan(20);
    expect(await HintCell.countDocuments({ status: HintCellStatus.Solving })).toBeGreaterThan(0);
    expect(await HintCell.countDocuments({ status: HintCellStatus.Open })).toBeGreaterThan(0);
    expect(await HintCell.countDocuments({ check: HintCheck.Disputed })).toBe(1);

    // A solved answer parses (RD) onto its hint marker, inside its fox's area
    const teams = await Team.find().lean();
    for (const cell of solved) {
      const rd = parseRdAnswer(cell.answer!)!;
      expect(rd).not.toBeNull();
      const marker = await Marker.findById(cell.markerId).lean();
      expect(marker!.type).toBe(MarkerType.Hint);
      expect(marker!.time).toEqual(cell.slotTime);
      expect(marker!.location.coordinates).toEqual([rd.lng, rd.lat]);
      const own = teams.filter((team) => team.area?.toLowerCase() === cell.area).map((team) => team.location.coordinates);
      const pad = 0.01;
      expect(rd.lng).toBeGreaterThan(Math.min(...own.map((c) => c[0])) - pad);
      expect(rd.lng).toBeLessThan(Math.max(...own.map((c) => c[0])) + pad);
      expect(rd.lat).toBeGreaterThan(Math.min(...own.map((c) => c[1])) - pad);
      expect(rd.lat).toBeLessThan(Math.max(...own.map((c) => c[1])) + pad);
    }
    expect(await Marker.countDocuments({ type: MarkerType.Hint })).toBe(solved.length);
    expect(await Marker.countDocuments({ type: MarkerType.Spot })).toBe(4);
    expect(await Marker.countDocuments({ type: MarkerType.Hunt })).toBe(10);
    expect(await Marker.countDocuments({ time: { $gt: now } })).toBe(0);

    // Users: the copied real user + 8 demo hunters with trackers
    expect(await User.countDocuments()).toBe(9);
    const hunters = await User.find({ "tracker.deviceId": { $gte: 900001 } }).lean();
    expect(hunters.map((user) => user.name).sort()).toEqual(DEMO_HUNTERS.map((hunter) => hunter.name).sort());
    expect(hunters.every((user) => !user.admin && !user.requiresPasswordChange && user.password.startsWith("$argon2"))).toBe(true);

    // Hunt reports with photos
    const reports = await listHuntReports(now);
    expect(reports).toHaveLength(10);
    const count = (status: string) => reports.filter((report) => report.status === status).length;
    expect([count("judged"), count("submitted"), count("to_submit"), count("overdue")]).toEqual([3, 3, 3, 1]);
    expect(reports.filter((report) => report.needsReview)).toHaveLength(1);
    expect(reports.every((report) => report.ocrStatus === "done" && report.huntCode && report.duplicateOf === null)).toBe(true);
    const photos = await readdir(demoUploadsDir());
    const stored = (await HuntReport.find().lean()).map((report) => report.photo);
    expect(stored.every((photo) => photos.includes(photo))).toBe(true);
    expect(await Hunt.countDocuments({ status: "Goedgekeurd" })).toBe(3);

    // Simulated trackers
    expect(getSimulation()!.hunters).toHaveLength(8);
    const positions = simulatedPositions(new Date());
    expect(positions.filter((position) => Date.now() - Date.parse(position.fixTime) < 60_000)).toHaveLength(6);
    expect(before).toBeLessThanOrEqual(Date.now());

    await switchDemoMode(false);
    expect(getSimulation()).toBeNull();
    // The real database is untouched: no areas assigned, no demo users
    await withRealDb(async (db) => {
      expect(await db.collection("teams").countDocuments({ area: { $exists: true } })).toBe(0);
      expect(await db.collection("users").countDocuments()).toBe(1);
      expect(await db.collection("articles").countDocuments()).toBe(0);
    });
  }, 60_000);
});
