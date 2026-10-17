/**
 * The score card on the logged-in jotihunt.nl dashboard (/scoutingGroup/dashboard), as a pure function over its HTML.
 *
 * Checked against the real site on 17 Oct 2026: "Voorlopig aantal punten: N" above a grid of
 * `<div><div class="font-bold">Hunts: </div>0</div>` cells (Hunts, Tegenhunts, Opdrachten, Foto opdrachten, Hints,
 * Strafpunten). A value can be empty (0 so far) or "?" (not known yet, e.g. Hints).
 */
import { htmlToText } from "./html-text";

export interface ScoreParts {
  hunts: number | null;
  counterHunts: number | null;
  assignments: number | null;
  photoAssignments: number | null;
  /** null while the site shows "?" */
  hints: number | null;
  /** Points subtracted, as the positive number the site shows */
  penalty: number | null;
}

export interface SiteScore {
  /** The site's total, never recomputed from the parts */
  total: number | null;
  parts: ScoreParts;
}

const TOTAL_LABEL = /^voorlopig aantal punten\s*:?\s*(.*)$/i;

/** The label of each part (whole label at the start of a line, so "Hunts:" never matches "Tegenhunts:") */
const LABELS: Record<keyof ScoreParts, RegExp> = {
  hunts: /^hunts\s*:\s*(.*)$/i,
  counterHunts: /^tegenhunts\s*:\s*(.*)$/i,
  assignments: /^opdrachten\s*:\s*(.*)$/i,
  photoAssignments: /^foto\s*opdrachten\s*:\s*(.*)$/i,
  hints: /^hints\s*:\s*(.*)$/i,
  penalty: /^strafpunten\s*:\s*(.*)$/i,
};

const isLabel = (line: string) => TOTAL_LABEL.test(line) || Object.values(LABELS).some((label) => label.test(line));

/** "" → 0, "?" → null, "145" / "1.234" / "−10" → the number; other text → null */
export function scoreValue(text: string): number | null {
  const value = text.trim();
  if (value === "") return 0;
  if (value === "?") return null;
  const match = /^[-−–]?\s*\d[\d.\s]*$/.exec(value);
  if (!match) return null;
  const number = Number(value.replace(/[.\s]/g, "").replace(/[−–]/, "-"));
  return Number.isFinite(number) ? number : null;
}

/** The value after a label: the rest of its line, else the next line when that is no other label */
function valueAfter(lines: string[], index: number, rest: string): string {
  if (rest.trim() !== "") return rest;
  const next = lines[index + 1];
  return next !== undefined && !isLabel(next) ? next : "";
}

/** The score card, or null when the page has no "Voorlopig aantal punten" (not the dashboard, or a new layout) */
export function parseScorePage(html: string): SiteScore | null {
  const lines = htmlToText(html).split("\n");
  const start = lines.findIndex((line) => TOTAL_LABEL.test(line));
  if (start === -1) return null;
  const card = lines.slice(start);
  const total = scoreValue(valueAfter(card, 0, TOTAL_LABEL.exec(card[0])![1]));
  const part = (key: keyof ScoreParts): number | null => {
    const index = card.findIndex((line) => LABELS[key].test(line));
    if (index === -1) return null;
    return scoreValue(valueAfter(card, index, LABELS[key].exec(card[index])![1]));
  };
  const penalty = part("penalty");
  return {
    total,
    parts: {
      hunts: part("hunts"),
      counterHunts: part("counterHunts"),
      assignments: part("assignments"),
      photoAssignments: part("photoAssignments"),
      hints: part("hints"),
      penalty: penalty === null ? null : Math.abs(penalty),
    },
  };
}
