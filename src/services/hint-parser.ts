import { AREAS } from "../constants/areas";

export const DEFAULT_AREAS: string[] = [...AREAS];

export interface ParsedAreaHint {
  snippet: string | null;
  none: boolean;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPlainText(html: string) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split a Jotihunt hint article into per-area parts.
 * Hint articles contain lines like "Alpha: <img>", "Bravo: -". A dash-only part means
 * the area has no hint this round. Areas that can't be found get a null snippet, so the
 * client falls back to showing the full article.
 * @param html The article HTML content
 * @param areaNames The area names to look for (case-insensitive)
 * @returns A record keyed by lowercase area name
 */
export function parseHintArticle(html: string, areaNames: string[] = DEFAULT_AREAS): Record<string, ParsedAreaHint> {
  const names = areaNames.map((name) => name.toLowerCase());
  const result: Record<string, ParsedAreaHint> = {};
  for (const name of names) result[name] = { snippet: null, none: false };

  // An area label must follow a tag, whitespace or the start, so names inside attributes don't match
  const pattern = new RegExp(`(^|>|\\s|&nbsp;)(${names.map(escapeRegExp).join("|")})(?:\\s|&nbsp;)*:`, "gi");
  const matches: { area: string; start: number; end: number }[] = [];
  for (const match of html.matchAll(pattern)) {
    const area = match[2].toLowerCase();
    if (matches.some((existing) => existing.area === area)) continue;
    matches.push({ area, start: match.index + match[1].length, end: match.index + match[0].length });
  }

  matches.forEach((match, index) => {
    const raw = html.slice(match.end, matches[index + 1]?.start ?? html.length);
    const text = toPlainText(raw);
    const hasMedia = /<(img|figure|a)\b/i.test(raw);
    if (!hasMedia && /^[-–—\s]+$/.test(text)) {
      result[match.area] = { snippet: null, none: true };
    } else if (hasMedia || text !== "") {
      result[match.area] = { snippet: raw.trim(), none: false };
    }
  });

  return result;
}
