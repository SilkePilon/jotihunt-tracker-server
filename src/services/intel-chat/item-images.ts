import { articleImages, fetchImages, type ArticleImage, type FetchedImage } from "../article-media";

/** Downloaded item images are reused for this long (every chat turn sends them again) */
export const ITEM_IMAGE_CACHE_MS = 10 * 60_000;
const MAX_CACHED_ITEMS = 3;

const cache = new Map<string, { at: number; images: Promise<FetchedImage[]> }>();

/** Tests only */
export function clearItemImageCache() {
  cache.clear();
}

/**
 * The item's images for the model, with the same rules as the summaries (fetchImages: at most 20, 5 MB each, 14 MB in
 * total, https on jotihunt.net/.nl only). Cached per article content for 10 minutes (not when nothing came through); never throws (text only then).
 */
export async function loadItemImages(
  article: { id: number; content: string; contentHash?: string | null },
  download: (images: ArticleImage[]) => Promise<FetchedImage[]> = (images) => fetchImages(images),
  now = Date.now(),
): Promise<FetchedImage[]> {
  const images = articleImages(article.content);
  if (images.length === 0) return [];
  const key = `${article.id}:${article.contentHash ?? article.content.length}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < ITEM_IMAGE_CACHE_MS) return hit.images;
  const loading = download(images).catch(() => [] as FetchedImage[]);
  const entry = { at: now, images: loading };
  cache.delete(key);
  cache.set(key, entry);
  // Nothing downloaded (failed or empty): try again next turn
  void loading.then((fetched) => {
    if (fetched.length === 0 && cache.get(key) === entry) cache.delete(key);
  });
  while (cache.size > MAX_CACHED_ITEMS) cache.delete(cache.keys().next().value!);
  return loading;
}
