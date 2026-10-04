import { generateText, jsonSchema, Output, type JSONSchema7, type LanguageModel } from "ai";
import { Article, publicArticlesFilter } from "../models/article.model";
import { invalidAnswer, toGeminiError } from "./ai/gemini-error";
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

const clock = (date: Date) => date.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Amsterdam" });

export function buildSummaryPrompt(article: SummaryInput): string {
  const kind = article.type === "assignment" ? "assignment" : "news message";
  const facts = [`Title: ${article.title}`];
  if (article.endTime) facts.push(`Deadline: ${clock(new Date(article.endTime))}`);
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
    { _id: 0, id: 1, title: 1, type: 1, content: 1, endTime: 1, maxPoints: 1, contentHash: 1 },
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

type Tracked = <T>(fn: () => Promise<T>) => Promise<T | undefined>;

/**
 * Background job: summarise what is pending. The Gemini call runs outside `tracked` (it can take long); reading and
 * storing run inside it, so nothing is stored into another database after a demo switch. A failing article is tried
 * `maxAttempts` times for the same content and then left without a summary.
 */
export function createSummaryJob({
  summarizer,
  tracked = (fn) => fn(),
  maxAttempts = 2,
  batch = 3,
}: {
  summarizer: ArticleSummarizer;
  tracked?: Tracked;
  maxAttempts?: number;
  batch?: number;
}) {
  const attempts = new Map<number, { hash: string; count: number }>();
  const givenUp = (article: PendingArticle) => {
    const entry = attempts.get(article.id);
    return entry?.hash === article.contentHash && entry.count >= maxAttempts;
  };

  return {
    async run() {
      const done: number[] = [];
      const failed: { id: number; error: unknown }[] = [];
      // Read a few more than the batch, so articles that were given up on do not block the ones behind them
      const pending = ((await tracked(() => findPendingSummaries(batch + attempts.size))) ?? []).filter((article) => !givenUp(article)).slice(0, batch);
      for (const article of pending) {
        try {
          const summary = await summarizer.summarize(article);
          const stored = await tracked(async () => {
            await storeSummary(article, summary);
            return true;
          });
          if (stored) done.push(article.id);
        } catch (error) {
          const entry = attempts.get(article.id);
          attempts.set(article.id, { hash: article.contentHash, count: entry?.hash === article.contentHash ? entry.count + 1 : 1 });
          failed.push({ id: article.id, error });
        }
      }
      return { done, failed };
    },
  };
}
