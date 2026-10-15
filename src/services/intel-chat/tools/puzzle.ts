import { google } from "@ai-sdk/google";
import { generateText, jsonSchema, tool, type LanguageModel } from "ai";
import { toGeminiError } from "../../ai/gemini-error";
import { safely, ToolInputError, type IntelToolContext } from "./context";

export const RUN_CODE_TIMEOUT_MS = 60_000;
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
export async function runCode(model: LanguageModel, task: string, abortSignal?: AbortSignal): Promise<RunCodeResult> {
  const text = String(task ?? "").trim();
  if (!text || text.length > MAX_TASK) throw new ToolInputError("Taak moet 1 tot 4000 tekens zijn");
  try {
    const result = await generateText({
      model,
      instructions: "Los deze taak op door Python-code te schrijven en uit te voeren. Geef daarna kort het resultaat in het Nederlands. Reken nooit uit je hoofd.",
      prompt: text,
      tools: { code_execution: google.tools.codeExecution({}) },
      maxRetries: 0,
      timeout: RUN_CODE_TIMEOUT_MS,
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
    throw toGeminiError(error);
  }
}

export function puzzleTools(ctx: IntelToolContext) {
  return {
    runCode: tool({
      description: "Laat een precieze rekentaak uitvoeren met Python: ciphers decoderen (Caesar met alle shifts, binair, morse-tabellen), letters tellen, stapeltellen, rekenwerk. Beschrijf de taak volledig met alle invoer.",
      inputSchema: jsonSchema<{ task: string }>({ type: "object", properties: { task: { type: "string", description: "De volledige taak met alle gegevens" } }, required: ["task"] }),
      execute: ({ task }, { abortSignal }) => safely("runCode", () => runCode(ctx.toolModel, task, abortSignal)),
    }),
  };
}
