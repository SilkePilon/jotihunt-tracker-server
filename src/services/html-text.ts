const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

/** Plain text of an article's (Trix) HTML, for a language model: one line per block, images as "[afbeelding]" */
export function htmlToText(html: string): string {
  return html
    .replace(/<img\b[^>]*>/gi, "[afbeelding]\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>|<\/(div|p|li|ul|ol|h[1-6]|figure|figcaption|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity])
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}
