import { generateText, jsonSchema, Output, type JSONSchema7, type LanguageModel } from "ai";
import { Article } from "../models/article.model";
import { HintCell, HintCellStatus } from "../models/hint-cell.model";
import { invalidAnswer, toGeminiError } from "./ai/gemini-error";
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
const BLOCK_END = /<br\s*\/?>|<\/p\s*>|<\/div\s*>|<\/li\s*>|<\/figure\s*>|<hr\b[^>]*>|<\/h[1-6]\s*>/gi;

const attribute = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find((v) => v !== undefined);

/** "[afbeelding: <alt>]", or the file name of its src when it has no alt */
function imageLabel(tag: string): string {
  const alt = attribute(tag, "alt")?.trim();
  const src = attribute(tag, "src") ?? "";
  const name = alt || src.split(/[?#]/)[0].split("/").pop() || "";
  return name ? `[afbeelding: ${name}]` : "[afbeelding]";
}

function blockText(html: string): string {
  // htmlToText puts blocks on lines (and "- " before a list item); inside one block a line break is just a space
  const marked = html.replace(/<li\b[^>]*>/gi, "").replace(/<img\b[^>]*>/gi, (tag) => ` ${imageLabel(tag).replace(/</g, "&lt;")} `);
  return htmlToText(marked)
    .replace(/\s+/g, " ")
    .trim();
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
    if (!text && !/<img\b/i.test(piece)) continue;
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
- A part may span several blocks, and may be (or include) an image.
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
    split.push({ area: name, none: none === true && usable.length === 0, blocks: usable });
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
  const blocks = hintBlocks(article.content);
  const changed: string[] = [];
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
