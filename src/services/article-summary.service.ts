import { generateText, jsonSchema, Output, type JSONSchema7, type LanguageModel } from "ai";
import { Article, publicArticlesFilter } from "../models/article.model";
import { GeminiError, invalidAnswer, toGeminiError } from "./ai/gemini-error";
import { htmlToText } from "./html-text";

export interface ArticleSummary {
  summary: string;
  /** What it means for our team; may be empty */
  points: string[];
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
const MAX_POINTS = 4;
const MAX_POINT_CHARS = 200;

const SUMMARY_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" }, points: { type: "array", items: { type: "string" } } },
  required: ["summary", "points"],
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
- "points": 0 to ${MAX_POINTS} short points on what our team must do or change because of it. Empty when nothing follows from it.

Use only what the text says. Do not invent times, places or rules.

${facts.join("\n")}
Text:
${htmlToText(article.content).slice(0, MAX_TEXT_CHARS)}`;
}

/** The parts of the answer we can use; an answer without a summary is invalid */
function cleanSummary(output: unknown): ArticleSummary {
  const raw = (output ?? {}) as { summary?: unknown; points?: unknown };
  const summary = typeof raw.summary === "string" ? raw.summary.trim().slice(0, MAX_SUMMARY_CHARS) : "";
  if (!summary) throw invalidAnswer();
  const points = (Array.isArray(raw.points) ? raw.points : [])
    .filter((point): point is string => typeof point === "string")
    .map((point) => point.trim().slice(0, MAX_POINT_CHARS))
    .filter((point) => point.length > 0)
    .slice(0, MAX_POINTS);
  return { summary, points };
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
    { $set: { summary: summary.summary, summaryPoints: summary.points, summaryHash: article.contentHash } },
  );
}

/** Pause of the job after a failure that says Gemini is down or busy; doubles on every next one in a row */
export const SUMMARY_PAUSE_MS = 120_000;
/** Longest pause of the job */
export const SUMMARY_MAX_PAUSE_MS = 900_000;

type Tracked = <T>(fn: () => Promise<T>) => Promise<T | undefined>;

const isOutage = (error: unknown) => error instanceof GeminiError && error.retryable;

/**
 * Background job: summarise what is pending, one article per run by default (summaries are not urgent and share the
 * API key with the time-critical reading of hunt photos). `beginRun` gives every run its own `tracked` wrapper, bound
 * to the database the run started on: reading and storing run inside it, the Gemini call outside it (it can take
 * long). When a tracked call is skipped (a demo switch happened) the run stops.
 *
 * A retryable failure (Gemini down or busy: 429, 5xx, timeout, network) stops the run and pauses the job:
 * 2 minutes at first, doubling on every next such failure up to 15 minutes, back to 2 after a success. Any other
 * failure counts for the article: after `maxAttempts` of them for the same content it is left without a summary.
 */
export function createSummaryJob({
  summarizer,
  beginRun = () => (fn) => fn(),
  maxAttempts = 2,
  batch = 1,
  now = Date.now,
}: {
  summarizer: ArticleSummarizer;
  beginRun?: () => Tracked;
  maxAttempts?: number;
  batch?: number;
  now?: () => number;
}) {
  const attempts = new Map<number, { hash: string; count: number }>();
  const givenUp = (article: PendingArticle) => {
    const entry = attempts.get(article.id);
    return entry?.hash === article.contentHash && entry.count >= maxAttempts;
  };
  let pausedUntil = 0;
  let nextPause = SUMMARY_PAUSE_MS;

  return {
    async run() {
      const done: number[] = [];
      const failed: { id: number; error: unknown }[] = [];
      if (now() < pausedUntil) return { done, failed };
      const tracked = beginRun();
      // Read a few more than the batch, so articles that were given up on do not block the ones behind them
      const pending = ((await tracked(() => findPendingSummaries(batch + attempts.size))) ?? []).filter((article) => !givenUp(article)).slice(0, batch);
      for (const article of pending) {
        try {
          const summary = await summarizer.summarize(article);
          nextPause = SUMMARY_PAUSE_MS;
          const stored = await tracked(async () => {
            await storeSummary(article, summary);
            return true;
          });
          if (!stored) break;
          attempts.delete(article.id);
          done.push(article.id);
        } catch (error) {
          failed.push({ id: article.id, error });
          if (isOutage(error)) {
            pausedUntil = now() + nextPause;
            nextPause = Math.min(nextPause * 2, SUMMARY_MAX_PAUSE_MS);
            break;
          }
          const entry = attempts.get(article.id);
          attempts.set(article.id, { hash: article.contentHash, count: entry?.hash === article.contentHash ? entry.count + 1 : 1 });
        }
      }
      return { done, failed };
    },
  };
}
