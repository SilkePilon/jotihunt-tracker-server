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

describe("no per-turn limit on paid sub-calls", () => {
  test("no tool has a limit", () => {
    expect(Object.values(TURN_LIMITS).every((limit) => limit === Infinity)).toBe(true);
  });

  test("web searches, code runs and walking routes keep going far past the old limits", async () => {
    const { tools, counts } = turnTools();
    for (let i = 0; i < 20; i++) expect(await runTool(tools.webSearch, { query: `vraag ${i}` })).toMatchObject({ answer: "ok" });
    for (let i = 0; i < 20; i++) expect(await runTool(tools.runCode, { task: `som ${i}` })).toMatchObject({ answer: "ok" });
    const input = { from: "188362 440722", to: "188362 441722", walking: true };
    for (let i = 0; i < 20; i++) expect(await runTool(tools.distance, input)).toMatchObject({ walkMinutes: 42, walkEstimate: false });
    expect(counts).toEqual({ gemini: 40, walking: 20 });
  });
});
