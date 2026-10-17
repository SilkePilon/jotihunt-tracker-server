import { afterEach, describe, expect, test } from "bun:test";
import { localGoogle, mockModel } from "../../../test/ai";
import { runTool } from "../../../test/tools";
import { GeminiError } from "../../ai/gemini-error";
import { RUN_CODE_TOO_SLOW, puzzleTools, runCode } from "./puzzle";

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

  test("a task that runs past the deadline says it was too slow, not that Gemini is unreachable", async () => {
    const google = localGoogle(async () => {
      await Bun.sleep(500);
      return Response.json({});
    });
    stop = google.stop;
    const error = await runCode(google.model("x"), "zware taak", undefined, 50).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GeminiError);
    expect((error as GeminiError).message).toBe(RUN_CODE_TOO_SLOW);
  });

  test("a stopped turn is not reported as too slow", async () => {
    const google = localGoogle(async () => {
      await Bun.sleep(500);
      return Response.json({});
    });
    stop = google.stop;
    const turn = new AbortController();
    setTimeout(() => turn.abort(), 50);
    const error = await runCode(google.model("x"), "zware taak", turn.signal, 5000).catch((e: unknown) => e);
    expect((error as GeminiError).message).not.toBe(RUN_CODE_TOO_SLOW);
  });

  test("an empty task is refused", async () => {
    const google = localGoogle(() => Response.json({}));
    stop = google.stop;
    expect(await runTool(puzzleTools({ articleId: 1, now: () => new Date(), toolModel: google.model("x") }).runCode, { task: " " })).toEqual({ error: "Taak moet 1 tot 4000 tekens zijn" });
  });
});

describe("decodeCipher", () => {
  const tools = puzzleTools({ articleId: 1, now: () => new Date(), toolModel: mockModel(() => "") });

  test("decodes without AI, best first", async () => {
    const { results } = (await runTool(tools.decodeCipher, { text: "qr ibf vf va urg obf" })) as { results: unknown[] };
    expect(results[0]).toEqual({ method: "caesar", detail: "ROT13", output: "de vos is in het bos" });
    expect(await runTool(tools.decodeCipher, { text: "LXFOPVEFRNHR", method: "vigenere", key: "LEMON" })).toEqual({ results: [{ method: "vigenere", detail: "sleutel LEMON", output: "ATTACKATDAWN" }] });
  });

  test("bad input is a Dutch error", async () => {
    expect(await runTool(tools.decodeCipher, { text: "abc", method: "rot47" })).toEqual({ error: "Onbekende methode: rot47" });
  });
});
