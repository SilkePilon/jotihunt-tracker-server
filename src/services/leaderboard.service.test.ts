import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { HintCell, HintCellStatus } from "../models/hint-cell.model";
import { HuntReport } from "../models/hunt-report.model";
import { User } from "../models/user.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { createLeaderboardService } from "./leaderboard.service";
import type { TraccarApi } from "./traccar-api";

const START = "2026-10-17T10:00:00+02:00";
const END = "2026-10-18T12:00:00+02:00";

function fakeApi(getSummary: TraccarApi["getSummary"]): { api: TraccarApi; calls: number[] } {
  const calls: number[] = [];
  const unused = async (): Promise<never> => {
    throw new Error("not used");
  };
  const api: TraccarApi = {
    findDevice: unused,
    getDevice: unused,
    createDevice: unused,
    updateDevice: unused,
    getPosition: unused,
    getDistance: unused,
    async getSummary(deviceId, from, to) {
      calls.push(deviceId);
      return getSummary(deviceId, from, to);
    },
  };
  return { api, calls };
}

async function seed() {
  const merida = await User.create({ email: "merida@test.nl", password: "x", name: "Merida", tracker: { deviceId: 5, uniqueId: "jh-x", vehicle: "car" } });
  await User.create({ email: "mulan@test.nl", password: "x", name: "Mulan" });
  await HuntReport.create({
    area: "alpha",
    huntCode: "AB1",
    huntTime: new Date(),
    photo: "p.jpg",
    reportedBy: merida._id,
    reportedByName: "Merida",
    site: { status: "Goedgekeurd", points: 10, seenAt: new Date() },
  });
  await HintCell.create({ articleId: 1, area: "alpha", publishAt: new Date(), slotTime: new Date(), status: HintCellStatus.Solved, claimedBy: merida._id });
}

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("createLeaderboardService", () => {
  test("combines hunts, hints and tracker distance", async () => {
    await seed();
    const { api } = fakeApi(async () => ({ distance: 10_000, maxSpeed: 20 }));
    const board = await createLeaderboardService({ api, huntStart: START, huntEnd: END }).get();
    expect(board.distanceAvailable).toBe(true);
    expect(board.entries.map((entry) => [entry.name, entry.score, entry.rank])).toEqual([
      ["Merida", 17, 1],
      ["Mulan", 0, 2],
    ]);
    expect(board.entries[0]).toMatchObject({ topSpeedKmh: 37, distanceKm: 10, hints: 1, hunts: 1 });
  });

  test("marks distance unavailable when Traccar fails", async () => {
    await seed();
    const errors: unknown[] = [];
    const { api } = fakeApi(async () => {
      throw new Error("down");
    });
    const board = await createLeaderboardService({ api, huntStart: START, onError: (error) => errors.push(error) }).get();
    expect(board.distanceAvailable).toBe(false);
    expect(errors).toHaveLength(1);
    expect(board.entries[0]).toMatchObject({ name: "Merida", distanceKm: 0, score: 15 });
  });

  test("marks distance unavailable without Traccar", async () => {
    await seed();
    const board = await createLeaderboardService({ api: null }).get();
    expect(board.distanceAvailable).toBe(false);
    expect(board.entries).toHaveLength(2);
  });

  test("caches for 60 seconds", async () => {
    await seed();
    let time = new Date("2026-10-17T15:00:00+02:00");
    const { api, calls } = fakeApi(async () => ({ distance: 1000, maxSpeed: 1 }));
    const service = createLeaderboardService({ api, huntStart: START, now: () => time });
    await service.get();
    time = new Date(time.getTime() + 30_000);
    await service.get();
    expect(calls).toHaveLength(1);
    time = new Date(time.getTime() + 31_000);
    await service.get();
    expect(calls).toHaveLength(2);
  });
});
