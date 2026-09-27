import { RoutingCache } from "../../models/routing-cache.model";

/** A cached routing result, or undefined when missing or expired. */
export async function readCache<T>(key: string): Promise<T | undefined> {
  return (await readCacheEntry<T>(key))?.value;
}

/** Like readCache, but also tells whether the value is a cached fallback estimate. */
export async function readCacheEntry<T>(key: string): Promise<{ value: T; estimate: boolean } | undefined> {
  const entry = await RoutingCache.findOne({ key }).lean();
  if (!entry || entry.expiresAt.getTime() <= Date.now()) return undefined;
  return { value: entry.value as T, estimate: entry.estimate === true };
}

export async function writeCache(key: string, value: unknown, ttlMs: number, options: { estimate?: boolean } = {}): Promise<void> {
  await RoutingCache.updateOne(
    { key },
    { $set: { value, expiresAt: new Date(Date.now() + ttlMs), estimate: options.estimate ?? false } },
    { upsert: true },
  );
}
