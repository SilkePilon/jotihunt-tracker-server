import { generateText, jsonSchema, Output, type JSONSchema7, type LanguageModel } from "ai";
import { Article, legacySummaryKey, publicArticlesFilter, SUMMARY_DEBOUNCE_MS, SUMMARY_VERSION, summaryKey } from "../models/article.model";
import { GeminiError, invalidAnswer, toGeminiError } from "./ai/gemini-error";
import { createGeminiJob, GEMINI_JOB_MAX_PAUSE_MS, GEMINI_JOB_PAUSE_MS, type Tracked } from "./ai/gemini-job";
import { articleAttachments, articleImages, fetchImages as downloadImages, type ArticleImage, type FetchedImage } from "./article-media";
import { articleTextHash, hashContent } from "./article-text-hash";
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

/**
 * The prompt text. `images` are the names of the images sent along with it (in order); the article's other images and
 * its files that are not images are only named.
 */
export function buildSummaryPrompt(article: SummaryInput, images: string[] = []): string {
  const kind = article.type === "assignment" ? "assignment" : "news message";
  const facts = [`Title: ${article.title}`];
  if (article.publishAt) facts.push(`Published: ${dayAndTime(new Date(article.publishAt))}`);
  if (article.endTime) facts.push(`Deadline: ${dayAndTime(new Date(article.endTime))}`);
  if (article.maxPoints != null) facts.push(`Max points: ${article.maxPoints}`);
  const attachments = articleAttachments(article.content);
  if (attachments.length > 0) facts.push(`Bijlagen: ${attachments.join(", ")}`);
  if (images.length > 0) facts.push(`Bijgevoegde afbeeldingen: ${images.join(", ")}`);
  // Images that are not attached (not on a Jotihunt host, or not downloaded) are only named
  const notAttached = articleImages(article.content).map((image) => image.name);
  for (const name of images) {
    const at = notAttached.indexOf(name);
    if (at >= 0) notAttached.splice(at, 1);
  }
  if (notAttached.length > 0) facts.push(`Niet bijgevoegde afbeeldingen: ${notAttached.join(", ")}`);
  const source =
    images.length > 0
      ? "Use only what the text and the attached images (the article's own images, in this order) say; read what the images show (text, times, places, instructions) as part of the article. Do not invent times, places or rules."
      : "Use only what the text says. Do not invent times, places or rules.";
  return `You help the headquarters of a scouting group that plays Jotihunt, a weekend-long fox hunt game in Gelderland (the Netherlands). The organisation published this ${kind}. Summarise it for the team, in Dutch.

- "summary": at most 2 short sentences with the facts that matter (what, when, deadline, points).

${source}

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

/** The article's images that could be downloaded; never throws (a summary without images beats none) */
async function attachedImages(content: string, fetchImages: (images: ArticleImage[]) => Promise<FetchedImage[]>): Promise<FetchedImage[]> {
  const images = articleImages(content);
  if (images.length === 0) return [];
  try {
    return await fetchImages(images);
  } catch {
    return [];
  }
}

/**
 * Summarises one article with one Gemini call, its images attached (downloaded first, with their own limits; the
 * timeout covers the Gemini call only). When Gemini refuses a call with images (not an outage) it is asked once more
 * with the text only; any other retrying is the job's business.
 */
export function createArticleSummarizer({
  model,
  timeoutMs = SUMMARY_TIMEOUT_MS,
  fetchImages = (images) => downloadImages(images),
}: {
  model: LanguageModel;
  timeoutMs?: number;
  fetchImages?: (images: ArticleImage[]) => Promise<FetchedImage[]>;
}): ArticleSummarizer {
  return {
    async summarize(article) {
      const ask = async (images: FetchedImage[]) => {
        try {
          const result = await generateText({
            model,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: buildSummaryPrompt(article, images.map((image) => image.name)) },
                  ...images.map((image) => ({ type: "file" as const, data: image.data, mediaType: image.mediaType, filename: image.name })),
                ],
              },
            ],
            output: Output.object({ schema: jsonSchema(SUMMARY_SCHEMA) }),
            temperature: 0.2,
            maxRetries: 0,
            timeout: timeoutMs,
          });
          return cleanSummary(result.output);
        } catch (error) {
          throw toGeminiError(error);
        }
      };
      const images = await attachedImages(article.content, fetchImages);
      try {
        return await ask(images);
      } catch (error) {
        // Gemini refused the request or the answer (a bad image, too large): once more with the text only. An outage
        // (timeout, 429, 5xx, network) is the job's business.
        if (images.length === 0 || !(error instanceof GeminiError) || error.retryable) throw error;
        return ask([]);
      }
    },
  };
}

export { SUMMARY_DEBOUNCE_MS };

export interface PendingArticle extends SummaryInput {
  id: number;
  textHash: string;
}

/**
 * News and assignments whose current text has no summary (of the current version) yet, newest first. A text that
 * changed less than SUMMARY_DEBOUNCE_MS before `now` waits (its old summary stays visible meanwhile).
 */
export async function findPendingSummaries(limit: number, now = new Date()): Promise<PendingArticle[]> {
  const articles = await Article.find(
    {
      ...publicArticlesFilter(),
      type: { $in: ["news", "assignment"] },
      textHash: { $type: "string" },
      textChangedAt: { $lte: new Date(now.getTime() - SUMMARY_DEBOUNCE_MS) },
      $expr: { $ne: ["$summaryHash", { $concat: ["$textHash", `:${SUMMARY_VERSION}`] }] },
    },
    { _id: 0, id: 1, title: 1, type: 1, content: 1, publishAt: 1, endTime: 1, maxPoints: 1, textHash: 1 },
  )
    .sort({ publishAt: -1 })
    .limit(limit)
    .lean();
  return articles as PendingArticle[];
}

/** Store a summary, unless the article's text changed since it was made; whether it was stored */
export async function storeSummary(article: { id: number; textHash: string }, summary: ArticleSummary): Promise<boolean> {
  const result = await Article.updateOne(
    { id: article.id, textHash: article.textHash },
    { $set: { summary: summary.summary, summaryHash: summaryKey(article.textHash) }, $unset: { summaryPoints: 1 } },
    // summaryPoints is no longer in the schema; strict mode would drop the $unset
    { strict: false },
  );
  return result.matchedCount > 0;
}

/**
 * Give every article stored before textHash existed its textHash (from its stored content), with a textChangedAt
 * older than the debounce. A v2 summary of the content as stored is still current: it is re-keyed to v3 (no new
 * Gemini call). Idempotent: articles that have a textHash are left alone.
 */
export async function migrateArticleTextHashes(now = new Date()): Promise<{ hashed: number; rekeyed: number }> {
  const stable = new Date(now.getTime() - SUMMARY_DEBOUNCE_MS - 1);
  const articles = await Article.find({ textHash: { $exists: false } }, { _id: 1, content: 1, contentHash: 1, summaryHash: 1 }).lean();
  let hashed = 0;
  let rekeyed = 0;
  for (const article of articles) {
    const textHash = articleTextHash(article.content);
    const current = Boolean(article.contentHash) && article.contentHash === hashContent(article.content) && article.summaryHash === legacySummaryKey(article.contentHash!);
    const result = await Article.updateOne(
      // Not when the sync stored a textHash meanwhile
      { _id: article._id, textHash: { $exists: false } },
      { $set: { textHash, textChangedAt: stable, ...(current ? { summaryHash: summaryKey(textHash) } : {}) } },
    );
    hashed += result.modifiedCount;
    if (current) rekeyed += result.modifiedCount;
  }
  return { hashed, rekeyed };
}

/** Pause of the job after a failure that says Gemini is down or busy; doubles on every next one in a row */
export const SUMMARY_PAUSE_MS = GEMINI_JOB_PAUSE_MS;
/** Longest pause of the job */
export const SUMMARY_MAX_PAUSE_MS = GEMINI_JOB_MAX_PAUSE_MS;

/**
 * Background job: summarise what is pending, one article per run by default (summaries are not urgent and share the
 * API key with the other AI jobs). Pause, give-up and demo-switch rules: see createGeminiJob.
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
  return createGeminiJob({
    findPending: (limit) => findPendingSummaries(limit),
    work: (article) => summarizer.summarize(article),
    store: storeSummary,
    hashOf: (article) => article.textHash,
    ...options,
  });
}
