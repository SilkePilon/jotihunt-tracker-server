import { afterEach, describe, expect, test } from "bun:test";
import { localGoogle } from "../../../test/ai";
import { runTool } from "../../../test/tools";
import { puzzleTools } from "./puzzle";

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

describe("runCode", () => {
  test("asks Gemini with code execution and returns answer, code and output", async () => {
    const bodies: Record<string, unknown>[] = [];
    const google = localGoogle(async (request) => {
      bodies.push((await request.json()) as Record<string, unknown>);
      return Response.json({
        candidates: [
          {
            content: { role: "model", parts: [{ executableCode: { language: "PYTHON", code: "print(sum(map(int, '2126')))" } }, { codeExecutionResult: { outcome: "OUTCOME_OK", output: "11\n" } }, { text: "De cijfersom is 11." }] },
            finishReason: "STOP",
          },
        ],
      });
    });
    stop = google.stop;
    const tools = puzzleTools({ articleId: 1, now: () => new Date(), toolModel: google.model("gemini-test") });
    expect(await runTool(tools.runCode, { task: "cijfersom van 2126" })).toEqual({ answer: "De cijfersom is 11.", code: "print(sum(map(int, '2126')))", output: "11\n" });
    expect(bodies[0].tools).toEqual([{ codeExecution: {} }]);
  });

  test("an empty task is refused", async () => {
    const google = localGoogle(() => Response.json({}));
    stop = google.stop;
    expect(await runTool(puzzleTools({ articleId: 1, now: () => new Date(), toolModel: google.model("x") }).runCode, { task: " " })).toEqual({ error: "Taak moet 1 tot 4000 tekens zijn" });
  });
});
