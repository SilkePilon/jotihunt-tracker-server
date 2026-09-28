import { describe, expect, test } from "bun:test";
import { buildLeaderboard, distanceWindow, type DeviceSummary, type LeaderboardInput } from "./leaderboard.helpers";

const NOW = new Date("2026-10-17T15:00:00+02:00");
const START = "2026-10-17T10:00:00+02:00";
const END = "2026-10-18T12:00:00+02:00";

function input(overrides: Partial<LeaderboardInput> = {}): LeaderboardInput {
  return {
    users: [
      { id: "a", name: "Merida", deviceId: 1 },
      { id: "b", name: "Mulan", deviceId: 2 },
      { id: "c", name: "Admin" },
    ],
    reports: [],
    solvedBy: [],
    summaries: new Map<number, DeviceSummary>(),
    distanceAvailable: true,
    window: distanceWindow(NOW, START, END),
    now: NOW,
    ...overrides,
  };
}

describe("distanceWindow", () => {
  test("hunt window while the hunt runs", () => {
    expect(distanceWindow(NOW, START, END)).toEqual({ from: new Date(START), to: NOW, kind: "hunt" });
  });
  test("ends at HUNT_END_TIME after the hunt", () => {
    const after = new Date("2026-10-19T09:00:00+02:00");
    expect(distanceWindow(after, START, END)).toEqual({ from: new Date(START), to: new Date(END), kind: "hunt" });
  });
  test("today before the hunt or without a valid start", () => {
    const before = new Date("2026-09-28T15:00:00+02:00");
    const today = new Date(before);
    today.setHours(0, 0, 0, 0);
    expect(distanceWindow(before, START, END)).toEqual({ from: today, to: before, kind: "today" });
    expect(distanceWindow(before, undefined, undefined).kind).toBe("today");
    expect(distanceWindow(before, "nonsense", undefined).kind).toBe("today");
  });
});

describe("buildLeaderboard", () => {
  test("adds up hunts, judged points, hints and full 5 km blocks", () => {
    const board = buildLeaderboard(
      input({
        reports: [
          { reportedBy: "a", sitePoints: 10 },
          { reportedBy: "a", sitePoints: null },
          { reportedBy: "b", sitePoints: 0 },
        ],
        solvedBy: ["a", "b", "b"],
        summaries: new Map([
          [1, { distanceM: 14_900, maxSpeedKmh: 38 }],
          [2, { distanceM: 5_000, maxSpeedKmh: 92 }],
        ]),
      }),
    );
    const merida = board.entries.find((entry) => entry.name === "Merida")!;
    expect(merida).toMatchObject({ hunts: 2, approvedHunts: 1, huntPoints: 10, hints: 1, distanceKm: 14.9, topSpeedKmh: 38 });
    expect(merida.breakdown).toEqual({ hunts: 4, huntPoints: 10, hints: 3, distance: 2 });
    expect(merida.score).toBe(19);
    const mulan = board.entries.find((entry) => entry.name === "Mulan")!;
    expect(mulan.score).toBe(2 + 0 + 6 + 1);
    expect(board.totals).toEqual({ distanceKm: 19.9, hunts: 3, hints: 3, fastest: { name: "Mulan", speedKmh: 92 } });
  });

  test("users without a tracker or data get 0 and are still listed", () => {
    const board = buildLeaderboard(input());
    expect(board.entries.map((entry) => [entry.name, entry.score, entry.distanceKm, entry.topSpeedKmh])).toContainEqual(["Admin", 0, 0, null]);
    expect(board.entries).toHaveLength(3);
    expect(board.totals.fastest).toBeNull();
  });

  test("equal scores share a place; more hunts first, then name", () => {
    const board = buildLeaderboard(
      input({
        users: [
          { id: "a", name: "Zora" },
          { id: "b", name: "Anna" },
          { id: "c", name: "Bram" },
          { id: "d", name: "Cas" },
        ],
        reports: [{ reportedBy: "a", sitePoints: 1 }],
        solvedBy: ["b"],
      }),
    );
    // Zora 2+1=3 with 1 hunt, Anna 3 with 0 hunts, Bram 0, Cas 0
    expect(board.entries.map((entry) => [entry.name, entry.rank])).toEqual([
      ["Zora", 1],
      ["Anna", 1],
      ["Bram", 3],
      ["Cas", 3],
    ]);
  });

  test("passes window and availability through", () => {
    const board = buildLeaderboard(input({ distanceAvailable: false }));
    expect(board).toMatchObject({ distanceAvailable: false, distanceWindow: "hunt", distanceSince: new Date(START).toISOString(), updatedAt: NOW.toISOString() });
  });
});
