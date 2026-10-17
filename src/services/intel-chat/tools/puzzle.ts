import { google } from "@ai-sdk/google";
import { generateText, jsonSchema, tool, type LanguageModel } from "ai";
import { GeminiError, toGeminiError } from "../../ai/gemini-error";
import { CIPHER_METHODS, decodeCipher } from "../cipher";
import { BUDGET_EXHAUSTED, createTurnBudget, safely, spend, ToolInputError, type IntelToolContext } from "./context";

/** Heavy tasks (dozens of items, several code runs) take over a minute */
export const RUN_CODE_TIMEOUT_MS = 150_000;
export const RUN_CODE_TOO_SLOW = "Rekentaak duurde te lang; maak de taak kleiner of splits hem op";
const MAX_TASK = 4000;
const MAX_OUTPUT = 4000;

export interface RunCodeResult {
  answer: string;
  code: string | null;
  output: string | null;
}

/**
 * Let Gemini write and run Python for a precise task (ciphers, counting, arithmetic) in its own sub-call with the
 * built-in code execution tool. Returns its answer plus the last code it ran and that code's output.
 */
export async function runCode(model: LanguageModel, task: string, abortSignal?: AbortSignal, timeoutMs = RUN_CODE_TIMEOUT_MS): Promise<RunCodeResult> {
  const text = String(task ?? "").trim();
  if (!text || text.length > MAX_TASK) throw new ToolInputError("Taak moet 1 tot 4000 tekens zijn");
  try {
    const result = await generateText({
      model,
      instructions: "Los deze taak op door Python-code te schrijven en uit te voeren. Geef daarna kort het resultaat in het Nederlands. Reken nooit uit je hoofd.",
      prompt: text,
      tools: { code_execution: google.tools.codeExecution({}) },
      maxRetries: 0,
      timeout: timeoutMs,
      abortSignal,
    });
    let code: string | null = null;
    let output: string | null = null;
    for (const part of result.content) {
      if (part.type === "tool-call" && part.toolName === "code_execution") code = String((part.input as { code?: unknown })?.code ?? "") || null;
      if (part.type === "tool-result" && part.toolName === "code_execution") output = String((part.output as { output?: unknown })?.output ?? "") || null;
    }
    return { answer: result.text.trim().slice(0, MAX_OUTPUT), code: code?.slice(0, MAX_OUTPUT) ?? null, output: output?.slice(0, MAX_OUTPUT) ?? null };
  } catch (error) {
    // Our own deadline, not the turn being stopped: say so, else the model reads "niet bereikbaar" and gives up
    const name = (error as { name?: unknown } | null)?.name;
    if (!abortSignal?.aborted && (name === "TimeoutError" || name === "AbortError")) throw new GeminiError(RUN_CODE_TOO_SLOW, false);
    throw toGeminiError(error);
  }
}

export function puzzleTools(ctx: IntelToolContext) {
  const budget = ctx.budget ?? createTurnBudget();
  return {
    decodeCipher: tool({
      description:
        "Ontcijfer tekst zonder AI, exact: caesar (alle 25 verschuivingen), atbash, a1z26, morse, roman, dutch-numbers (Nederlandse getalwoorden → cijfers), reverse, mirror-digits (cijfer → 9 - cijfer), vigenere (met key), nato, keypad (T9 multi-tap). Zonder method: alle passende methodes, meest leesbare/RD-achtige eerst (max 30).",
      inputSchema: jsonSchema<{ text: string; method?: string; key?: string }>({
        type: "object",
        properties: {
          text: { type: "string", description: "De gecodeerde tekst (max 2000 tekens)" },
          method: { type: "string", enum: [...CIPHER_METHODS], description: "Eén methode; weglaten om alles te proberen" },
          key: { type: "string", description: "Sleutelwoord voor vigenere" },
        },
        required: ["text"],
      }),
      execute: ({ text, method, key }) => safely("decodeCipher", async () => decodeCipher(text, method, key)),
    }),
    runCode: tool({
      description: "Laat een precieze rekentaak uitvoeren met Python: ciphers decoderen (Caesar met alle shifts, binair, morse-tabellen), letters tellen, stapeltellen, rekenwerk. Beschrijf de taak volledig met alle invoer.",
      inputSchema: jsonSchema<{ task: string }>({ type: "object", properties: { task: { type: "string", description: "De volledige taak met alle gegevens" } }, required: ["task"] }),
      execute: ({ task }, { abortSignal }) => (spend(budget, "runCode") ? safely("runCode", () => runCode(ctx.toolModel, task, abortSignal)) : { error: BUDGET_EXHAUSTED }),
    }),
  };
}
