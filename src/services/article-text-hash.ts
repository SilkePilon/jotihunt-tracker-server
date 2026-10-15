import { createHash } from "node:crypto";
import { articleAttachments, articleImages } from "./article-media";
import { htmlToText } from "./html-text";

/** sha256 of the raw HTML (contentHash: a changed hint article is flagged and split again) */
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Hash of what a summary is made from: the readable text (all whitespace collapsed) plus the article's images (by URL)
 * and other attached files (by name), sorted and once each. Re-saving an article in the organisation's (Trix) editor
 * often changes only the markup; that keeps this hash, so the summary stays current (contentHash, of the raw HTML, does
 * change and drives the hint flags).
 */
export function articleTextHash(content: string): string {
  const text = htmlToText(content).replace(/\s+/g, " ").trim();
  const files = [...new Set([...articleImages(content).map((image) => image.url), ...articleAttachments(content).map((name) => `bijlage:${name}`)])].sort();
  return createHash("sha256").update(`${text}\n${files.join("\n")}`).digest("hex");
}
