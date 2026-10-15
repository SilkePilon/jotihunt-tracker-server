import { google } from "@ai-sdk/google";
import { generateText, jsonSchema, tool, type LanguageModel } from "ai";
import { toGeminiError } from "../../ai/gemini-error";
import { readWebPage } from "../web-fetch";
import { BUDGET_EXHAUSTED, createTurnBudget, safely, spend, ToolInputError, type IntelToolContext } from "./context";

/** Tools that reach the internet; only active when the user switched "Web" on */
export const WEB_TOOL_NAMES = ["webSearch", "readWebPage"] as const;

export interface WebSearchResult {
  answer: string;
  sources: { title: string; url: string }[];
}

/** One Google-grounded sub-call; the answer is short, it goes back into the chat's own model */
export const WEB_SEARCH_TIMEOUT_MS = 30_000;
const MAX_SOURCES = 8;
const MAX_ANSWER_CHARS = 4000;

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/**
 * Search the web with Gemini's Google Search grounding (its own call: built-in tools are not mixed with our function
 * tools). Sources come from the grounding metadata, once per URL.
 */
export async function webSearch(model: LanguageModel, query: string, abortSignal?: AbortSignal): Promise<WebSearchResult> {
  const q = String(query ?? "").trim();
  if (!q || q.length > 300) throw new ToolInputError("Zoekvraag moet 1 tot 300 tekens zijn");
  try {
    const result = await generateText({
      model,
      instructions: "Zoek dit op met Google Search en antwoord kort en feitelijk in het Nederlands (max 8 zinnen). Noem concrete getallen, namen en plaatsen. Verzin niets.",
      prompt: q,
      tools: { google_search: google.tools.googleSearch({}) },
      maxRetries: 0,
      timeout: WEB_SEARCH_TIMEOUT_MS,
      abortSignal,
    });
    const sources: WebSearchResult["sources"] = [];
    for (const source of result.sources) {
      if (source.sourceType !== "url" || sources.some((known) => known.url === source.url)) continue;
      sources.push({ title: source.title?.trim() || hostOf(source.url), url: source.url });
      if (sources.length >= MAX_SOURCES) break;
    }
    return { answer: result.text.trim().slice(0, MAX_ANSWER_CHARS), sources };
  } catch (error) {
    throw toGeminiError(error);
  }
}

export function webTools(ctx: IntelToolContext) {
  const budget = ctx.budget ?? createTurnBudget();
  return {
    webSearch: tool({
      description: "Zoek op internet (Google). Voor feiten, plaatsen, namen, trivia en codes die je niet zeker weet. Geeft een kort antwoord met bronnen.",
      inputSchema: jsonSchema<{ query: string }>({ type: "object", properties: { query: { type: "string", description: "Zoekvraag, zo specifiek mogelijk" } }, required: ["query"] }),
      execute: ({ query }, { abortSignal }) => (spend(budget, "webSearch") ? safely("webSearch", () => webSearch(ctx.toolModel, query, abortSignal)) : { error: BUDGET_EXHAUSTED }),
    }),
    readWebPage: tool({
      description: "Lees een openbare webpagina als platte tekst (max 20 000 tekens), bv. een bron uit webSearch of een link uit een hint.",
      inputSchema: jsonSchema<{ url: string }>({ type: "object", properties: { url: { type: "string", description: "http(s)-adres" } }, required: ["url"] }),
      execute: ({ url }, { abortSignal }) => safely("readWebPage", () => readWebPage(url, { fetch: ctx.fetch, lookup: ctx.lookup, signal: abortSignal })),
    }),
  };
}
