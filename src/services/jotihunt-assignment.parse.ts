/**
 * The "Insturen" card of a logged-in jotihunt.nl assignment page (/bericht/{id}), as a pure function over its HTML.
 *
 * Checked against the real site on 17 Oct 2026:
 * - not handed in: an upload form (`action=".../article/assignment/{id}"`);
 * - handed in: `<h2>Je hebt deze opdracht reeds ingestuurd</h2>`, `<p class="font-bold">Ingestuurd:</p>`, the photo as
 *   `<img src="https://cdn.jotihunt.net/...">`, optionally `Jullie waardering: ★★★★ (4 / 5)` (our own star rating of the
 *   assignment), and a footer `<p class="font-bold">Nog niet beoordeeld</p>`. The wording once judged is not known
 *   yet: the footer text is kept as-is and a number of points is read from it when there is one.
 */
import { htmlToText } from "./html-text";

export interface SiteSubmission {
  /** The page has an "Insturen" card at all (false: not an assignment page, or a new layout) */
  found: boolean;
  submitted: boolean;
  /** The handed-in photo (http(s) only) */
  imageUrl: string | null;
  /** Our own star rating of the assignment, 1–5 */
  rating: number | null;
  /** The footer text as the site shows it, e.g. "Nog niet beoordeeld" */
  judgement: string | null;
  /** A judgement is there and it is not "nog niet beoordeeld" */
  judged: boolean;
  /** Points read from the judgement text; null when it has no number */
  points: number | null;
}

const textOf = (html: string) => htmlToText(html).replace(/\s+/g, " ").trim();

const decodeAttribute = (value: string) =>
  value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'");

/** Card titles: `<div class="theme-card-title …">…</div>` (an svg icon inside, no nested div) */
const CARD_TITLE = /<div\b[^>]*\bclass=["'][^"']*\btheme-card-title\b[^"']*["'][^>]*>((?:(?!<\/div>)[\s\S])*)<\/div>/gi;

/** The HTML of the "Insturen" card (after its title, up to the next card title), or null */
function submitCard(html: string): string | null {
  const titles = [...html.matchAll(CARD_TITLE)];
  const index = titles.findIndex((match) => /^insturen$/i.test(textOf(match[1])));
  if (index === -1) return null;
  const start = titles[index].index! + titles[index][0].length;
  const end = titles[index + 1]?.index ?? html.length;
  return html.slice(start, end);
}

const SUBMITTED_HEADING = /reeds\s+ingestuurd/i;
const SUBMITTED_LABEL = /<p\b[^>]*>\s*Ingestuurd:\s*<\/p>/i;
const NOT_JUDGED = /nog\s+niet\s+beoordeeld/i;

/** The first http(s) image after the "Ingestuurd:" label (or anywhere in the card without one) */
function submittedImage(card: string): string | null {
  const label = SUBMITTED_LABEL.exec(card);
  const after = label ? card.slice(label.index + label[0].length) : card;
  for (const tag of after.match(/<img\b[^>]*>/gi) ?? []) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!src) continue;
    const url = decodeAttribute(src.trim());
    if (/^https?:\/\//i.test(url)) return url;
  }
  return null;
}

/** The judgement: the last bold paragraph of the card that is not the "Ingestuurd:" label */
function judgementOf(card: string): string | null {
  const bold = [...card.matchAll(/<p\b[^>]*\bclass=["'][^"']*\bfont-bold\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/gi)].map((match) => textOf(match[1])).filter((text) => text !== "" && !/^ingestuurd:?$/i.test(text));
  return bold.at(-1) ?? null;
}

/** Points in a judgement: "25 punten" first, else the first whole number */
export function pointsOf(judgement: string | null): number | null {
  if (!judgement || NOT_JUDGED.test(judgement)) return null;
  const match = /(-?\d+)\s*(?:punten|punt|pnt|pt)\b/i.exec(judgement) ?? /(-?\d+)/.exec(judgement);
  return match ? Number(match[1]) : null;
}

export function parseAssignmentPage(html: string): SiteSubmission {
  const card = submitCard(html);
  if (card === null) return { found: false, submitted: SUBMITTED_HEADING.test(html), imageUrl: null, rating: null, judgement: null, judged: false, points: null };
  const submitted = SUBMITTED_HEADING.test(card) || SUBMITTED_LABEL.test(card);
  if (!submitted) return { found: true, submitted: false, imageUrl: null, rating: null, judgement: null, judged: false, points: null };
  const rating = /\((\d)\s*\/\s*5\)/.exec(textOf(card))?.[1];
  const judgement = judgementOf(card);
  return {
    found: true,
    submitted: true,
    imageUrl: submittedImage(card),
    rating: rating ? Number(rating) : null,
    judgement,
    judged: judgement !== null && !NOT_JUDGED.test(judgement),
    points: pointsOf(judgement),
  };
}
