import { generateText, jsonSchema, Output, type JSONSchema7, type LanguageModel } from "ai";
import { Article, HINT_SPLIT_VERSION, hintSplitKey, publicArticlesFilter, TEXT_DEBOUNCE_MS } from "../models/article.model";
import { HintCell, HintCellStatus } from "../models/hint-cell.model";
import { invalidAnswer, toGeminiError } from "./ai/gemini-error";
import { createGeminiJob, GEMINI_JOB_MAX_PAUSE_MS, GEMINI_JOB_PAUSE_MS, type Tracked } from "./ai/gemini-job";
import { attribute, figureParts, fileName } from "./article-media";
import { getAreaNames } from "./article-sync.service";
import { articleTextHash, hashContent } from "./article-text-hash";
import { invalidateBoardCache } from "./hint-board.service";
import { htmlToText } from "./html-text";

/** One block of a hint article: its original HTML and its plain text (images as "[afbeelding: <alt or file name>]") */
export interface HintBlock {
  index: number;
  html: string;
  text: string;
}

/** What the AI says about one area: no hint this round, or the blocks that hold its part */
export interface AreaSplit {
  /** Lowercase */
  area: string;
  none: boolean;
  blocks: number[];
}

/** Only the areas the AI answered usably; an area missing here stays as the rule made it */
export type HintSplit = AreaSplit[];

export interface HintSplitter {
  /** Throws GeminiError */
  split(article: { title: string; content: string }, areas: string[]): Promise<HintSplit>;
}

/** Total time for one split (a flash model answers in seconds) */
export const HINT_SPLIT_TIMEOUT_MS = 30_000;
const MAX_BLOCK_CHARS = 500;

const SPLIT_SCHEMA = {
  type: "object",
  properties: {
    areas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          area: { type: "string" },
          none: { type: "boolean" },
          blocks: { type: "array", items: { type: "integer" } },
        },
        required: ["area", "none", "blocks"],
      },
    },
  },
  required: ["areas"],
} satisfies JSONSchema7;

/** A block ends after one of these (the closing tag stays with the block before it) */
const BLOCK_END = /<br\s*\/?>|<\/(?:p|div|li|ul|ol|figure|blockquote|pre|h[1-6])\s*>|<hr\b[^>]*>/gi;

const label = (kind: "afbeelding" | "bestand", name: string | undefined) => (name ? `[${kind}: ${name}]` : `[${kind}]`);

/** "[afbeelding: <alt or file name>]" for a loose <img> */
const imageLabel = (tag: string) => label("afbeelding", attribute(tag, "alt")?.trim() || fileName(attribute(tag, "src")));

/**
 * One label for a Trix attachment figure: an image ("[afbeelding: …]") or another file ("[bestand: …]"). The name is
 * the attachment's filename, else the caption's attachment__name, else the image's alt, else the file name of the
 * image src or link href.
 */
function figureLabel(figure: string): string {
  const { attachment, img, link, caption, isImage } = figureParts(figure);
  // The JSON filename is plain text (the other names are still HTML-encoded): encode it, as the label goes through htmlToText
  const filename = attachment.filename?.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const name = filename || caption || (img && attribute(img, "alt")?.trim()) || fileName(img ? attribute(img, "src") : link && attribute(link, "href"));
  return label(isImage ? "afbeelding" : "bestand", name);
}

/** A link with an href and nothing shown inside (no text, no image) gets "[bestand: <file name>]" */
function emptyLinkLabel(link: string, inner: string): string {
  const href = attribute(link, "href");
  if (!href || /<img\b/i.test(inner) || inner.replace(/<[^>]*>/g, "").trim()) return link;
  return `${link} ${label("bestand", fileName(href))} `;
}

function blockText(html: string): string {
  // htmlToText puts blocks on lines (and "- " before a list item); inside one block a line break is just a space
  const marked = html
    .replace(/<figure\b[^>]*>[\s\S]*?(?:<\/figure\s*>|$)/gi, (figure) => ` ${figureLabel(figure)} `)
    .replace(/(<a\b[^>]*>)([\s\S]*?)(?=<\/a\s*>|$)/gi, (_, link: string, inner: string) => emptyLinkLabel(link, inner) + inner)
    .replace(/<li\b[^>]*>/gi, "")
    .replace(/<img\b[^>]*>/gi, (tag) => ` ${imageLabel(tag)} `);
  return htmlToText(marked).replace(/\s+/g, " ").trim();
}

/** The article HTML cut into numbered blocks (from 0) at block boundaries; empty blocks are dropped */
export function hintBlocks(html: string): HintBlock[] {
  const pieces: string[] = [];
  let start = 0;
  for (const match of html.matchAll(BLOCK_END)) {
    const end = match.index + match[0].length;
    pieces.push(html.slice(start, end));
    start = end;
  }
  pieces.push(html.slice(start));
  const blocks: HintBlock[] = [];
  for (const piece of pieces) {
    const text = blockText(piece);
    if (!text && !/<img\b|<figure\b|<a\b[^>]*\bhref/i.test(piece)) continue;
    blocks.push({ index: blocks.length, html: piece.trim(), text });
  }
  return blocks;
}

const title = (area: string) => area.charAt(0).toUpperCase() + area.slice(1).toLowerCase();

export function buildHintSplitPrompt(article: { title: string; content: string }, areas: string[]): string {
  const lines = hintBlocks(article.content).map((block) => `[${block.index}] ${block.text.slice(0, MAX_BLOCK_CHARS)}`);
  const names = areas.map(title).join(", ");
  return `You help the headquarters of a scouting group that plays Jotihunt, a weekend-long fox hunt game in Gelderland (the Netherlands). The organisation published this hint article (in Dutch). A hint article has a shared intro and then, per deelgebied (area: ${names}), an encoded part that leads to that area's fox team.

Tell for every area which numbered blocks below hold its part:
- A part may span several blocks, and may be (or include) an image or a file. Images appear as "[afbeelding: name]" and files as "[bestand: name]"; the name (e.g. "Hint Oscar.png", "alpha.zip") can tell which area they belong to.
- Include the block with the area's own label (e.g. a lone "Alpha:" line) in that area's blocks.
- A part may be introduced for several areas at once, e.g. "Alpha en Bravo:": all of them get those blocks.
- "-" or "--" as an area's part means there is no hint for that area this round: answer "none": true and "blocks": [].
- Intro blocks, closing words and anything shared belong to no area.
- Use only the block numbers listed. Do not guess: give an area no blocks and "none": false when you cannot tell.

Answer JSON: { "areas": [{ "area": "alpha", "none": false, "blocks": [3, 4] }] }, one entry for every area: ${areas.map((area) => area.toLowerCase()).join(", ")}.

Title: ${article.title}
Blocks:
${lines.join("\n")}`;
}

/** The usable part of the answer; an answer without any usable area is invalid */
function cleanSplit(output: unknown, areas: string[], blockCount: number): HintSplit {
  const known = new Set(areas.map((area) => area.toLowerCase()));
  const raw = (output ?? {}) as { areas?: unknown };
  const entries = Array.isArray(raw.areas) ? raw.areas : [];
  const split: HintSplit = [];
  for (const entry of entries) {
    const { area, none, blocks } = (entry ?? {}) as { area?: unknown; none?: unknown; blocks?: unknown };
    if (typeof area !== "string") continue;
    const name = area.trim().toLowerCase();
    if (!known.has(name) || split.some((done) => done.area === name)) continue;
    const numbers = Array.isArray(blocks) ? blocks : [];
    const usable = [...new Set(numbers.filter((n): n is number => Number.isInteger(n) && n >= 0 && n < blockCount))];
    // No usable blocks and not "none": the AI could not tell, so the area keeps the rule's result
    if (usable.length === 0 && none !== true) continue;
    split.push({ area: name, none: usable.length === 0, blocks: usable });
  }
  if (split.length === 0) throw invalidAnswer();
  return split;
}

/** Splits one hint article with one Gemini call; retrying is the job's business */
export function createHintSplitter({ model, timeoutMs = HINT_SPLIT_TIMEOUT_MS }: { model: LanguageModel; timeoutMs?: number }): HintSplitter {
  return {
    async split(article, areas) {
      let output: unknown;
      try {
        const result = await generateText({
          model,
          prompt: buildHintSplitPrompt(article, areas),
          output: Output.object({ schema: jsonSchema(SPLIT_SCHEMA) }),
          temperature: 0.1,
          maxRetries: 0,
          timeout: timeoutMs,
        });
        output = result.output;
      } catch (error) {
        throw toGeminiError(error);
      }
      return cleanSplit(output, areas, hintBlocks(article.content).length);
    },
  };
}

/** The original HTML of the area's blocks joined in order; undefined when none or no blocks */
export function snippetFor(blocks: HintBlock[], split: AreaSplit): string | undefined {
  if (split.none || split.blocks.length === 0) return undefined;
  const wanted = new Set(split.blocks);
  const html = blocks
    .filter((block) => wanted.has(block.index))
    .map((block) => block.html)
    .join("");
  return html || undefined;
}

/** The same blocks (same count, same text per number): a split of one holds for the other */
const sameBlocks = (a: HintBlock[], b: HintBlock[]) => a.length === b.length && a.every((block, i) => block.text === b[i].text);

/**
 * Correct the article's cells by the split: per area with an AI result, an open or none cell gets status
 * none/open and the snippet of its blocks (solved cells are never touched). Compare-and-set on the status read, so a
 * solve that lands meanwhile wins. Then marks the article's text as split.
 *
 * Nothing is applied (`stored: false`) when the article's text changed since the split was made. A markup-only re-save
 * meanwhile (same text) keeps the split valid: the snippets come from the current HTML (rotated image URLs) when its
 * blocks are the same, else from the HTML that was split.
 */
export async function applyHintSplit(article: { id: number; content: string; textHash: string }, split: HintSplit): Promise<{ stored: boolean; changed: string[] }> {
  const changed: string[] = [];
  const current = await Article.findOne({ id: article.id }, { _id: 0, textHash: 1, content: 1 }).lean();
  // The split was made from an older text: leave the cells for the next split
  if (current?.textHash !== article.textHash) return { stored: false, changed };
  const splitBlocks = hintBlocks(article.content);
  const currentBlocks = typeof current.content === "string" && current.content !== article.content ? hintBlocks(current.content) : splitBlocks;
  const blocks = sameBlocks(currentBlocks, splitBlocks) ? currentBlocks : splitBlocks;
  for (const areaSplit of split) {
    const cell = await HintCell.findOne({ articleId: article.id, area: areaSplit.area }, { status: 1, snippet: 1 }).lean();
    if (!cell || cell.status === HintCellStatus.Solved) continue;
    const status = areaSplit.none ? HintCellStatus.None : HintCellStatus.Open;
    const snippet = snippetFor(blocks, areaSplit);
    if (cell.status === status && (cell.snippet ?? undefined) === snippet) continue;
    const update = snippet === undefined ? { $set: { status }, $unset: { snippet: 1 } } : { $set: { status, snippet } };
    const result = await HintCell.updateOne({ _id: cell._id, status: cell.status }, update);
    if (result.modifiedCount > 0) changed.push(areaSplit.area);
  }
  const marked = await Article.updateOne({ id: article.id, textHash: article.textHash }, { $set: { hintSplitHash: hintSplitKey(article.textHash) } });
  if (changed.length > 0) invalidateBoardCache();
  return { stored: marked.matchedCount > 0, changed };
}

export interface PendingHintSplit {
  id: number;
  title: string;
  content: string;
  textHash: string;
}

/**
 * Hint articles whose current text has not been split by the AI yet, newest first; never seeded test hints. A text
 * that changed less than TEXT_DEBOUNCE_MS before `now` waits (the cells keep their split meanwhile).
 */
export async function findPendingHintSplits(limit: number, now = new Date()): Promise<PendingHintSplit[]> {
  const articles = await Article.find(
    {
      ...publicArticlesFilter(),
      type: "hint",
      textHash: { $type: "string" },
      textChangedAt: { $lte: new Date(now.getTime() - TEXT_DEBOUNCE_MS) },
      $expr: { $ne: ["$hintSplitHash", { $concat: ["$textHash", `:${HINT_SPLIT_VERSION}`] }] },
    },
    { _id: 0, id: 1, title: 1, content: 1, textHash: 1 },
  )
    .sort({ publishAt: -1 })
    .limit(limit)
    .lean();
  return articles as PendingHintSplit[];
}

/**
 * Hint articles split by the version keyed on the raw HTML (hintSplitHash = contentHash) whose stored content is the
 * one split: re-key to the text (no new Gemini call). Run after migrateArticleTextHashes (needs textHash).
 * Idempotent; returns how many were re-keyed.
 */
export async function migrateHintSplitKeys(): Promise<number> {
  const articles = await Article.find(
    { type: "hint", contentHash: { $type: "string" }, textHash: { $type: "string" }, $expr: { $eq: ["$hintSplitHash", "$contentHash"] } },
    { _id: 1, content: 1, contentHash: 1, textHash: 1 },
  ).lean();
  let rekeyed = 0;
  for (const article of articles) {
    const { contentHash, textHash } = article as { contentHash: string; textHash: string };
    if (contentHash !== hashContent(article.content) || textHash !== articleTextHash(article.content)) continue;
    // Not when the sync stored other content meanwhile
    const result = await Article.updateOne({ _id: article._id, contentHash, textHash, hintSplitHash: contentHash }, { $set: { hintSplitHash: hintSplitKey(textHash) } });
    rekeyed += result.modifiedCount;
  }
  return rekeyed;
}

/** Pause of the job after a failure that says Gemini is down or busy; doubles on every next one in a row */
export const HINT_SPLIT_PAUSE_MS = GEMINI_JOB_PAUSE_MS;
/** Longest pause of the job */
export const HINT_SPLIT_MAX_PAUSE_MS = GEMINI_JOB_MAX_PAUSE_MS;

/**
 * Background job: let Gemini split pending hint articles (one per run by default) and correct their cells. `areas`
 * (read inside the tracked read) defaults to the areas the cells are made for. Pause, give-up and demo-switch rules:
 * see createGeminiJob.
 */
export function createHintSplitJob({
  splitter,
  areas = getAreaNames,
  ...options
}: {
  splitter: HintSplitter;
  areas?: () => Promise<string[]>;
  beginRun?: () => Tracked;
  maxAttempts?: number;
  batch?: number;
  now?: () => number;
}) {
  return createGeminiJob({
    findPending: async (limit: number) => {
      const [pending, names] = await Promise.all([findPendingHintSplits(limit), areas()]);
      return pending.map((article) => ({ ...article, areas: names }));
    },
    work: (article) => splitter.split({ title: article.title, content: article.content }, article.areas),
    // false: the text changed during the call (not done, not a failed attempt)
    store: async (article, split) => (await applyHintSplit(article, split)).stored,
    hashOf: (article) => article.textHash,
    ...options,
  });
}
