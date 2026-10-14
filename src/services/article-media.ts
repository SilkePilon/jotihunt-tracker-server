/**
 * Images and other files in an article's (Trix) HTML: names for prompts, and the images themselves for Gemini.
 * Trix writes an attachment as `<figure data-trix-attachment="{json}">` (the JSON entity-encoded in the attribute) with
 * an `<img>` for images or an `<a href>` for other files, and a caption with the file name in `attachment__name`.
 */

/** The value of one attribute of an HTML tag (double, single or not quoted), still HTML-encoded */
export const attribute = (tag: string, name: string) =>
  new RegExp(`(?:^|[\\s<"'])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find((v) => v !== undefined);

/** Last path segment of a URL, without query or hash */
export function fileName(url: string | undefined): string {
  const last = (url ?? "").split(/[?#]/)[0].split("/").pop() ?? "";
  try {
    return decodeURIComponent(last).trim();
  } catch {
    return last.trim();
  }
}

/** The few entities that occur in attribute values */
const decodeAttribute = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export interface TrixAttachment {
  filename?: string;
  contentType?: string;
  url?: string;
  href?: string;
}

/** Fields of a Trix figure's data-trix-attachment JSON (plain text, decoded); empty when it has none */
export function trixAttachment(figureTag: string): TrixAttachment {
  const raw = attribute(figureTag, "data-trix-attachment");
  if (!raw) return {};
  const json = decodeAttribute(raw);
  const string = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return { filename: string(parsed.filename), contentType: string(parsed.contentType), url: string(parsed.url), href: string(parsed.href) };
  } catch {
    // Cut off or otherwise broken JSON: pick the fields by hand
    const field = (key: string) => string(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(json)?.[1]);
    return { filename: field("filename"), contentType: field("contentType"), url: field("url"), href: field("href") };
  }
}

/** One Trix attachment figure, split into its parts */
export interface FigureParts {
  attachment: TrixAttachment;
  img?: string;
  link?: string;
  /** The caption's attachment__name (HTML-encoded) */
  caption?: string;
  isImage: boolean;
}

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|heic|heif|bmp|svg)$/i;

export function figureParts(figure: string): FigureParts {
  const openTag = /^<figure\b[^>]*>/i.exec(figure)?.[0] ?? "";
  const attachment = trixAttachment(openTag);
  const img = /<img\b[^>]*>/i.exec(figure)?.[0];
  const link = /<a\b[^>]*>/i.exec(figure)?.[0];
  const caption = /<span\b[^>]*\battachment__name\b[^>]*>([^<]*)<\/span>/i.exec(figure)?.[1]?.trim() || undefined;
  const isImage = img !== undefined || /^image\//i.test(attachment.contentType ?? "") || IMAGE_FILE.test(attachment.filename ?? "");
  return { attachment, img, link, caption, isImage };
}

/** A Trix figure (up to its end) or a loose <img> */
const FIGURE_OR_IMG = /<figure\b[^>]*>[\s\S]*?(?:<\/figure\s*>|$)|<img\b[^>]*>/gi;

const isHttpUrl = (url: string | undefined): url is string => {
  if (!url) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

export interface ArticleImage {
  url: string;
  name: string;
}

/**
 * Every image of the HTML in document order, once per URL: loose `<img src>` and Trix image attachments. Only
 * absolute http(s) URLs. The name is the Trix filename, else the caption's attachment__name, else alt, else the URL's
 * file name.
 */
export function articleImages(html: string): ArticleImage[] {
  const images: ArticleImage[] = [];
  const add = (url: string | undefined, ...names: (string | undefined)[]) => {
    const decoded = url && decodeAttribute(url).trim();
    if (!isHttpUrl(decoded) || images.some((image) => image.url === decoded)) return;
    images.push({ url: decoded, name: names.find((name) => name?.trim())?.trim() ?? fileName(decoded) });
  };
  for (const [found] of html.matchAll(FIGURE_OR_IMG)) {
    if (/^<img\b/i.test(found)) {
      add(attribute(found, "src"), decodeAttribute(attribute(found, "alt") ?? ""));
      continue;
    }
    const parts = figureParts(found);
    if (!parts.isImage) continue;
    const src = parts.img && attribute(parts.img, "src");
    const alt = parts.img && decodeAttribute(attribute(parts.img, "alt") ?? "");
    add(parts.attachment.url ?? parts.attachment.href ?? src, parts.attachment.filename, parts.caption && decodeAttribute(parts.caption), alt);
  }
  return images;
}

/**
 * Names of the files attached to the HTML that are not images (zip, pdf, docx …): Trix file attachments, by their
 * filename, else caption, else the link's file name. Once per name, in document order.
 */
export function articleAttachments(html: string): string[] {
  const names: string[] = [];
  for (const [found] of html.matchAll(/<figure\b[^>]*>[\s\S]*?(?:<\/figure\s*>|$)/gi)) {
    const parts = figureParts(found);
    if (parts.isImage) continue;
    const name = parts.attachment.filename || (parts.caption && decodeAttribute(parts.caption)) || fileName(parts.attachment.href ?? parts.attachment.url ?? (parts.link && attribute(parts.link, "href")));
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export interface FetchedImage {
  data: Uint8Array;
  mediaType: string;
  name: string;
}

export interface FetchImagesOptions {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  maxImages?: number;
  maxBytesEach?: number;
  maxBytesTotal?: number;
  timeoutMs?: number;
  /** Downloads at the same time */
  parallel?: number;
}

const MEDIA_TYPES: Record<string, string> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
  "image/heic": "image/heic",
  "image/heif": "image/heif",
};

/** The body, or null when it is larger than `max` bytes (stops reading there) */
async function readCapped(response: Response, max: number): Promise<Uint8Array | null> {
  if (!response.body) {
    const data = new Uint8Array(await response.arrayBuffer());
    return data.byteLength <= max ? data : null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

/** One image, or null when it fails, times out, is too large or is not an image type we send */
async function fetchOne(image: ArticleImage, fetchFn: NonNullable<FetchImagesOptions["fetch"]>, maxBytes: number, timeoutMs: number): Promise<FetchedImage | null> {
  if (!isHttpUrl(image.url)) return null;
  try {
    const response = await fetchFn(image.url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    // A redirect may only end on http(s)
    if (!response.ok || (response.url && !isHttpUrl(response.url))) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const mediaType = MEDIA_TYPES[(response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()];
    const length = Number(response.headers.get("content-length"));
    if (!mediaType || (Number.isFinite(length) && length > maxBytes)) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const data = await readCapped(response, maxBytes);
    return data && data.byteLength > 0 ? { data, mediaType, name: image.name } : null;
  } catch {
    return null;
  }
}

/**
 * Download the images in order (a few at a time) for a Gemini call. Keeps only png/jpeg/webp/gif/heic/heif, skips
 * an image that fails, times out or is over `maxBytesEach`, and stops at `maxImages` images or when the next one no
 * longer fits in `maxBytesTotal`. Never throws.
 */
export async function fetchImages(
  images: ArticleImage[],
  { fetch: fetchFn = fetch, maxImages = 20, maxBytesEach = 5 * 1024 * 1024, maxBytesTotal = 18 * 1024 * 1024, timeoutMs = 10_000, parallel = 4 }: FetchImagesOptions = {},
): Promise<FetchedImage[]> {
  const kept: FetchedImage[] = [];
  let total = 0;
  const candidates = images.filter((image) => isHttpUrl(image.url));
  for (let start = 0; start < candidates.length; start += parallel) {
    const batch = await Promise.all(candidates.slice(start, start + parallel).map((image) => fetchOne(image, fetchFn, maxBytesEach, timeoutMs)));
    for (const image of batch) {
      if (!image) continue;
      if (total + image.data.byteLength > maxBytesTotal) return kept;
      kept.push(image);
      total += image.data.byteLength;
      if (kept.length >= maxImages) return kept;
    }
  }
  return kept;
}
