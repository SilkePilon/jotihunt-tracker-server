import { afterEach, describe, expect, test } from "bun:test";
import { geminiReply, localGoogle } from "../../../test/ai";
import { runTool } from "../../../test/tools";
import { createIntelTools } from ".";
import { TURN_LIMITS } from "./context";

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

/** createIntelTools for one turn, with a fake Gemini and a fake ORS that count their calls */
function turnTools() {
  const counts = { gemini: 0, walking: 0 };
  const google = localGoogle(async () => {
    counts.gemini++;
    return geminiReply("ok");
  });
  stop = google.stop;
  const tools = createIntelTools({
    articleId: 1,
    now: () => new Date(),
    toolModel: google.model("gemini-test"),
    walkMinutes: async () => {
      counts.walking++;
      return { minutes: [42], estimate: false };
    },
  });
  return { tools, counts };
}

const LIMIT = { error: "Limiet voor deze vraag bereikt" };

describe("per-turn budget for paid sub-calls", () => {
  test("limits are 6 web searches, 4 code runs, 5 walking routes, 4 place searches, 3 aerial photos and 25 OV requests", () => {
    expect(TURN_LIMITS).toEqual({ webSearch: 6, runCode: 4, walkingRoute: 5, findPlaces: 4, lookAtPoint: 3, ov: 25 });
  });

  test("webSearch: the 7th call of a turn is refused without calling Gemini", async () => {
    const { tools, counts } = turnTools();
    for (let i = 0; i < 6; i++) expect(await runTool(tools.webSearch, { query: `vraag ${i}` })).toMatchObject({ answer: "ok" });
    expect(await runTool(tools.webSearch, { query: "nog een" })).toEqual(LIMIT);
    expect(counts.gemini).toBe(6);
  });

  test("runCode: the 5th call of a turn is refused without calling Gemini", async () => {
    const { tools, counts } = turnTools();
    for (let i = 0; i < 4; i++) expect(await runTool(tools.runCode, { task: `som ${i}` })).toMatchObject({ answer: "ok" });
    expect(await runTool(tools.runCode, { task: "nog een" })).toEqual(LIMIT);
    expect(counts.gemini).toBe(4);
  });

  test("distance: after 5 walking routes the walking time is a straight-line estimate", async () => {
    const { tools, counts } = turnTools();
    const input = { from: "188362 440722", to: "188362 441722", walking: true };
    for (let i = 0; i < 5; i++) expect(await runTool(tools.distance, input)).toMatchObject({ walkMinutes: 42, walkEstimate: false });
    const sixth = (await runTool(tools.distance, input)) as { walkMinutes: number; walkEstimate: boolean; distanceM: number };
    expect(sixth.walkEstimate).toBe(true);
    expect(sixth.walkMinutes).toBeGreaterThan(5);
    expect(counts.walking).toBe(5);
    // Without walking the distance is free
    expect(await runTool(tools.distance, { from: input.from, to: input.to })).toHaveProperty("distanceM");
  });

  test("every turn (createIntelTools call) starts with a fresh budget", async () => {
    const first = turnTools();
    for (let i = 0; i < 4; i++) await runTool(first.tools.runCode, { task: `som ${i}` });
    expect(await runTool(first.tools.runCode, { task: "x" })).toEqual(LIMIT);
    stop?.();
    const second = turnTools();
    expect(await runTool(second.tools.runCode, { task: "x" })).toMatchObject({ answer: "ok" });
  });
});
