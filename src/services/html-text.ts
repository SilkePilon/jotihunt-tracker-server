const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', nbsp: " ", euro: "€", hellip: "…" };

/** The character of one entity (named, decimal or hexadecimal); an entity we do not know stays as it is */
function decodeEntity(entity: string, body: string): string {
  if (!body.startsWith("#")) return NAMED_ENTITIES[body] ?? entity;
  const code = /^#x/i.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
  const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
  return valid ? String.fromCodePoint(code) : entity;
}

/**
 * Plain text of an article's (Trix) HTML, for a language model: one line per block, images as "[afbeelding]",
 * without scripts, styles and the file name and size Trix puts under an attachment.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<span\b[^>]*\bclass=["'][^"']*\battachment__(name|size)\b[^"']*["'][^>]*>[^<]*<\/span>/gi, "")
    .replace(/<img\b[^>]*>/gi, "[afbeelding]\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>|<\/(div|p|li|ul|ol|h[1-6]|figure|figcaption|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    // One pass, so an escaped entity ("&amp;lt;") stays text ("&lt;")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, decodeEntity)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}
