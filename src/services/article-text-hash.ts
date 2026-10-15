import { createHash } from "node:crypto";
import { articleAttachments, articleImages } from "./article-media";
import { htmlToText } from "./html-text";

/** sha256 of the raw HTML (contentHash: changes on every re-save, also a markup-only one) */
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Signed image URLs rotate (signature, host): identify an image by its lower-cased file name */
function imageKey(ref: string): string {
  try {
    const name = new URL(ref).pathname.split("/").filter(Boolean).pop();
    return (name ? decodeURIComponent(name) : ref).toLowerCase();
  } catch {
    return ref;
  }
}

/**
 * Hash of what a summary or AI hint split is made from: the readable text (all whitespace collapsed) plus the article's
 * images (by file name) and other attached files (by name), sorted and once each. Re-saving an article in the
 * organisation's (Trix) editor often changes only the markup; that keeps this hash, so the summary and hint split stay
 * current and the hint cells are not flagged as changed (contentHash, of the raw HTML, does change).
 */
export function articleTextHash(content: string): string {
  const text = htmlToText(content).replace(/[\u200b-\u200d\ufeff]/g, "").replace(/\s+/g, " ").trim();
  const files = [...new Set([...articleImages(content).map((image) => imageKey(image.url)), ...articleAttachments(content).map((name) => `bijlage:${name}`)])].sort();
  return createHash("sha256").update(`${text}\n${files.join("\n")}`).digest("hex");
}
