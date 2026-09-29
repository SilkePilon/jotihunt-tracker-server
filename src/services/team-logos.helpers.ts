/** Decode the few HTML entities that appear in group names ("'t Paddegat", "&"). */
function decodeEntities(text: string): string {
  return text
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Group names compared case- and whitespace-insensitively. */
export function normalizeTeamName(name: string): string {
  return decodeEntities(name).replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Group logos from the public jotihunt.nl/subscriptions page: every logo is an
 * `<img src="https://cdn.jotihunt.net/…" alt="Logo van {groepsnaam}">`. Returns normalised name → logo URL.
 */
export function parseTeamLogos(html: string): Map<string, string> {
  const logos = new Map<string, string>();
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    const src = tag.match(/\bsrc\s*=\s*"([^"]+)"/i)?.[1];
    const alt = tag.match(/\balt\s*=\s*"Logo van ([^"]+)"/i)?.[1];
    if (!src || !alt || !/^https:\/\//i.test(src)) continue;
    logos.set(normalizeTeamName(alt), decodeEntities(src));
  }
  return logos;
}
