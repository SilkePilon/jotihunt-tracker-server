import { describe, expect, test } from "bun:test";
import type { AreaFacts } from "./facts";
import { buildPrompt, clock, PREDICTION_SCHEMA } from "./prompt";

const now = new Date("2026-10-17T12:05:00Z"); // 14:05 in Amsterdam (CEST)
const facts: AreaFacts = {
  area: "alpha",
  status: "green",
  round: 1,
  now,
  estimate: false,
  groups: [{ teamApiId: 7, name: "Scouting Rijn", lng: 5.5, lat: 52.1, walkMinutes: 23 }],
  trail: [{ id: "m1", time: new Date("2026-10-17T11:00:00Z"), kind: "hint", lng: 5.48, lat: 52.08 }],
  previousVisited: [],
  manualVisits: [{ teamApiId: 7, state: "not_visited" }],
};

describe("buildPrompt", () => {
  test("clock uses Amsterdam time", () => {
    expect(clock(now)).toBe("14:05");
  });

  test("contains the rules, the local times, minutes ago, walk minutes and manual visits", () => {
    const prompt = buildPrompt(facts);
    expect(prompt).toContain("Jotihunt");
    expect(prompt).toContain("30 minutes");
    expect(prompt).toContain("23:00");
    expect(prompt).toContain('"now":"14:05"');
    expect(prompt).toContain('"time":"13:00"');
    expect(prompt).toContain('"minutesAgo":65');
    expect(prompt).toContain('"walkMinutes":23');
    expect(prompt).toContain('"state":"not_visited"');
    expect(prompt).toContain('"status":"green"');
  });

  test("schema requires every output field", () => {
    expect((PREDICTION_SCHEMA as { required: string[] }).required.sort()).toEqual(
      ["candidates", "confidence", "pin", "reason", "round", "visitedTeamApiIds"].sort(),
    );
  });
});
