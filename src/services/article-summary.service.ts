import { generateText, jsonSchema, Output, type JSONSchema7, type LanguageModel } from "ai";
import { Article, publicArticlesFilter } from "../models/article.model";
import { invalidAnswer, toGeminiError } from "./ai/gemini-error";
import { createGeminiJob, GEMINI_JOB_MAX_PAUSE_MS, GEMINI_JOB_PAUSE_MS, type Tracked } from "./ai/gemini-job";
import { htmlToText } from "./html-text";

export interface ArticleSummary {
  summary: string;
}

export interface SummaryInput {
  title: string;
  type: string;
  content: string;
  publishAt?: Date | null;
  endTime?: Date | null;
  maxPoints?: number | null;
}

export interface ArticleSummarizer {
  /** Throws GeminiError */
  summarize(article: SummaryInput): Promise<ArticleSummary>;
}

/** Total time for one summary (a flash model answers in seconds) */
export const SUMMARY_TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 6000;
const MAX_SUMMARY_CHARS = 600;

const SUMMARY_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
} satisfies JSONSchema7;

/** Dutch weekday and time, e.g. "zaterdag 15:30" (the game runs over a weekend, so the day matters) */
function dayAndTime(date: Date): string {
  const weekday = date.toLocaleDateString("nl-NL", { weekday: "long", timeZone: "Europe/Amsterdam" });
  const time = date.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Amsterdam" });
  return `${weekday} ${time}`;
}

export function buildSummaryPrompt(article: SummaryInput): string {
  const kind = article.type === "assignment" ? "assignment" : "news message";
  const facts = [`Title: ${article.title}`];
  if (article.publishAt) facts.push(`Published: ${dayAndTime(new Date(article.publishAt))}`);
  if (article.endTime) facts.push(`Deadline: ${dayAndTime(new Date(article.endTime))}`);
  if (article.maxPoints != null) facts.push(`Max points: ${article.maxPoints}`);
  return `You help the headquarters of a scouting group that plays Jotihunt, a weekend-long fox hunt game in Gelderland (the Netherlands). The organisation published this ${kind}. Summarise it for the team, in Dutch.

- "summary": at most 2 short sentences with the facts that matter (what, when, deadline, points).

Use only what the text says. Do not invent times, places or rules.

${facts.join("\n")}
Text:
${htmlToText(article.content).slice(0, MAX_TEXT_CHARS)}`;
}

/** The part of the answer we can use; an answer without a summary is invalid */
function cleanSummary(output: unknown): ArticleSummary {
  const raw = (output ?? {}) as { summary?: unknown };
  const summary = typeof raw.summary === "string" ? raw.summary.trim().slice(0, MAX_SUMMARY_CHARS) : "";
  if (!summary) throw invalidAnswer();
  return { summary };
}

/** Summarises one article with one Gemini call; retrying is the job's business */
export function createArticleSummarizer({ model, timeoutMs = SUMMARY_TIMEOUT_MS }: { model: LanguageModel; timeoutMs?: number }): ArticleSummarizer {
  return {
    async summarize(article) {
      let output: unknown;
      try {
        const result = await generateText({
          model,
          prompt: buildSummaryPrompt(article),
          output: Output.object({ schema: jsonSchema(SUMMARY_SCHEMA) }),
          temperature: 0.2,
          maxRetries: 0,
          timeout: timeoutMs,
        });
        output = result.output;
      } catch (error) {
        throw toGeminiError(error);
      }
      return cleanSummary(output);
    },
  };
}

export interface PendingArticle extends SummaryInput {
  id: number;
  contentHash: string;
}

/** News and assignments whose current content has no summary yet, newest first */
export async function findPendingSummaries(limit: number): Promise<PendingArticle[]> {
  const articles = await Article.find(
    { ...publicArticlesFilter(), type: { $in: ["news", "assignment"] }, contentHash: { $type: "string" }, $expr: { $ne: ["$summaryHash", "$contentHash"] } },
    { _id: 0, id: 1, title: 1, type: 1, content: 1, publishAt: 1, endTime: 1, maxPoints: 1, contentHash: 1 },
  )
    .sort({ publishAt: -1 })
    .limit(limit)
    .lean();
  return articles as PendingArticle[];
}

/** Store a summary, unless the article's content changed since it was made */
export async function storeSummary(article: { id: number; contentHash: string }, summary: ArticleSummary): Promise<void> {
  await Article.updateOne(
    { id: article.id, contentHash: article.contentHash },
    { $set: { summary: summary.summary, summaryHash: article.contentHash }, $unset: { summaryPoints: 1 } },
    // summaryPoints is no longer in the schema; strict mode would drop the $unset
    { strict: false },
  );
}

/** Pause of the job after a failure that says Gemini is down or busy; doubles on every next one in a row */
export const SUMMARY_PAUSE_MS = GEMINI_JOB_PAUSE_MS;
/** Longest pause of the job */
export const SUMMARY_MAX_PAUSE_MS = GEMINI_JOB_MAX_PAUSE_MS;

/**
 * Background job: summarise what is pending, one article per run by default (summaries are not urgent and share the
 * API key with the time-critical reading of hunt photos). Pause, give-up and demo-switch rules: see createGeminiJob.
 */
export function createSummaryJob({
  summarizer,
  ...options
}: {
  summarizer: ArticleSummarizer;
  beginRun?: () => Tracked;
  maxAttempts?: number;
  batch?: number;
  now?: () => number;
}) {
  return createGeminiJob({ findPending: findPendingSummaries, work: (article) => summarizer.summarize(article), store: storeSummary, ...options });
}
