import { describe, expect, test } from "bun:test";
import { mockModel } from "../../../test/ai";
import { runTool } from "../../../test/tools";
import { mapTools } from "./map";

const base = { articleId: 1, now: () => new Date(), toolModel: mockModel(() => "") };

describe("distance", () => {
  test("metres and bearing; walking via walkMinutes", async () => {
    const calls: unknown[] = [];
    const tools = mapTools({
      ...base,
      walkMinutes: async (from, to) => {
        calls.push({ from, to });
        return { minutes: [42], estimate: false };
      },
    });
    const result = (await runTool(tools.distance, { from: "188362 440722", to: "188362 441722", walking: true })) as { distanceM: number; bearingDeg: number };
    expect(Math.abs(result.distanceM - 1000)).toBeLessThan(5);
    // RD north is within a degree of true north here
    expect(Math.min(result.bearingDeg, 360 - result.bearingDeg)).toBeLessThan(1);
    expect(result).toMatchObject({ walkMinutes: 42, walkEstimate: false });
    expect(calls).toHaveLength(1);
    expect(await runTool(tools.distance, { from: "188362 440722", to: "188362 441722" })).not.toHaveProperty("walkMinutes");
  });

  test("walking without ORS is a straight-line estimate", async () => {
    const result = (await runTool(mapTools(base).distance, { from: "188362 440722", to: "188362 441722", walking: true })) as { walkMinutes: number; walkEstimate: boolean };
    expect(result.walkEstimate).toBe(true);
    expect(result.walkMinutes).toBeGreaterThan(5);
  });

  test("a bad point names the argument", async () => {
    expect(await runTool(mapTools(base).distance, { from: "x", to: "188362 441722" })).toEqual({ error: 'Kon geen coördinaat lezen uit from "x"' });
  });
});

describe("projectPoint", () => {
  test("from HQ by bearing and distance, all notations", async () => {
    const result = (await runTool(mapTools(base).projectPoint, { from: "188362 440722", bearingDeg: 90, distanceM: 1000 })) as { rd: { x: number; y: number }; formatted: { rd8: string } };
    expect(Math.abs(result.rd.x - 189362)).toBeLessThan(30);
    expect(Math.abs(result.rd.y - 440722)).toBeLessThan(30);
    expect(result.formatted.rd8).toBe("1894 4407");
  });

  test("distance out of range is an error", async () => {
    expect(await runTool(mapTools(base).projectPoint, { from: "188362 440722", bearingDeg: 90, distanceM: 200_000 })).toEqual({ error: "distanceM moet tussen 0 en 100000 liggen" });
  });
});
