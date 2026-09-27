import { RoutingCache } from "../../models/routing-cache.model";

/** A cached routing result, or undefined when missing or expired. */
export async function readCache<T>(key: string): Promise<T | undefined> {
  const entry = await RoutingCache.findOne({ key }).lean();
  if (!entry || entry.expiresAt.getTime() <= Date.now()) return undefined;
  return entry.value as T;
}

export async function writeCache(key: string, value: unknown, ttlMs: number): Promise<void> {
  await RoutingCache.updateOne({ key }, { $set: { value, expiresAt: new Date(Date.now() + ttlMs) } }, { upsert: true });
}
