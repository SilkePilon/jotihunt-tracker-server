import { generateText, jsonSchema, Output, type JSONSchema7, type LanguageModel } from "ai";
import { Article, publicArticlesFilter } from "../models/article.model";
import { HintCell, HintCellStatus } from "../models/hint-cell.model";
import { invalidAnswer, toGeminiError } from "./ai/gemini-error";
import { createGeminiJob, GEMINI_JOB_MAX_PAUSE_MS, GEMINI_JOB_PAUSE_MS, type Tracked } from "./ai/gemini-job";
import { getAreaNames } from "./article-sync.service";
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

const attribute = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find((v) => v !== undefined);

/** Last path segment of a URL, without query or hash */
const fileName = (url: string | undefined) => {
  const last = (url ?? "").split(/[?#]/)[0].split("/").pop() ?? "";
  try {
    return decodeURIComponent(last).trim();
  } catch {
    return last.trim();
  }
};

/** filename and contentType from a Trix figure's data-trix-attachment JSON (entity-encoded in the attribute) */
function trixAttachment(figureTag: string): { filename?: string; contentType?: string } {
  const raw = attribute(figureTag, "data-trix-attachment");
  if (!raw) return {};
  const json = raw.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
  const string = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  try {
    const parsed = JSON.parse(json) as { filename?: unknown; contentType?: unknown };
    return { filename: string(parsed.filename), contentType: string(parsed.contentType) };
  } catch {
    // Cut off or otherwise broken JSON: pick the fields by hand
    const field = (key: string) => string(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(json)?.[1]);
    return { filename: field("filename"), contentType: field("contentType") };
  }
}

const label = (kind: "afbeelding" | "bestand", name: string | undefined) => (name ? `[${kind}: ${name}]` : `[${kind}]`);

/** "[afbeelding: <alt or file name>]" for a loose <img> */
const imageLabel = (tag: string) => label("afbeelding", attribute(tag, "alt")?.trim() || fileName(attribute(tag, "src")));

/**
 * One label for a Trix attachment figure: an image ("[afbeelding: …]") or another file ("[bestand: …]"). The name is
 * the attachment's filename, else the caption's attachment__name, else the image's alt, else the file name of the
 * image src or link href.
 */
function figureLabel(figure: string): string {
  const openTag = /^<figure\b[^>]*>/i.exec(figure)?.[0] ?? "";
  const attachment = trixAttachment(openTag);
  const img = /<img\b[^>]*>/i.exec(figure)?.[0];
  const href = /<a\b[^>]*>/i.exec(figure)?.[0];
  const caption = /<span\b[^>]*\battachment__name\b[^>]*>([^<]*)<\/span>/i.exec(figure)?.[1]?.trim();
  const isImage = img !== undefined || /^image\//i.test(attachment.contentType ?? "");
  // The JSON filename is plain text (the other names are still HTML-encoded): encode it, as the label goes through htmlToText
  const filename = attachment.filename?.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const name =
    filename || caption || (img && attribute(img, "alt")?.trim()) || fileName(img ? attribute(img, "src") : href && attribute(href, "href"));
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

/**
 * Correct the article's cells by the split: per area with an AI result, an open or none cell gets status
 * none/open and the snippet of its blocks (solved cells are never touched). Compare-and-set on the status read, so a
 * solve that lands meanwhile wins. Then marks the article as split, unless its content changed since.
 */
export async function applyHintSplit(article: { id: number; content: string; contentHash: string }, split: HintSplit): Promise<{ changed: string[] }> {
  const changed: string[] = [];
  // The split was made from older content: leave the cells for the next split
  const stored = await Article.findOne({ id: article.id }, { _id: 0, contentHash: 1 }).lean();
  if (stored?.contentHash !== article.contentHash) return { changed };
  const blocks = hintBlocks(article.content);
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
  await Article.updateOne({ id: article.id, contentHash: article.contentHash }, { $set: { hintSplitHash: article.contentHash } });
  if (changed.length > 0) invalidateBoardCache();
  return { changed };
}

export interface PendingHintSplit {
  id: number;
  title: string;
  content: string;
  contentHash: string;
}

/** Hint articles whose current content has not been split by the AI yet, newest first; never seeded test hints */
export async function findPendingHintSplits(limit: number): Promise<PendingHintSplit[]> {
  const articles = await Article.find(
    { ...publicArticlesFilter(), type: "hint", contentHash: { $type: "string" }, $expr: { $ne: ["$hintSplitHash", "$contentHash"] } },
    { _id: 0, id: 1, title: 1, content: 1, contentHash: 1 },
  )
    .sort({ publishAt: -1 })
    .limit(limit)
    .lean();
  return articles as PendingHintSplit[];
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
    store: (article, split) => applyHintSplit(article, split),
    ...options,
  });
}
