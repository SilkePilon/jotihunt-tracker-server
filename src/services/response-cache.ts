import type { Response } from "express";
import mongoose from "mongoose";
import { currentGeneration } from "../editions/work-tracking";

/**
 * Tiny in-memory cache of the JSON bodies of the polled list endpoints. Every hunter polls the same lists every few
 * seconds; within the TTL they all get the same serialised body instead of one query + build + stringify each.
 * Writes to a collection invalidate its entry (see the model middleware); entries are keyed by the database generation
 * and name, so an edition switch never serves the other database's data.
 */
export type CachedList = "markers" | "articles" | "hunts";

export const RESPONSE_CACHE_TTL_MS = 1_000;

interface Entry {
  key: string;
  expiresAt: number;
  body: Promise<string>;
}

const entries = new Map<CachedList, Entry>();

function databaseKey(): string {
  return `${currentGeneration()}:${mongoose.connection.name}`;
}

/** The serialised list: from the cache, or built once (concurrent callers share one build). */
export function cachedJson(list: CachedList, build: () => Promise<unknown>, ttlMs = RESPONSE_CACHE_TTL_MS): Promise<string> {
  const key = databaseKey();
  const entry = entries.get(list);
  if (entry && entry.key === key && entry.expiresAt > Date.now()) return entry.body;
  const body = build().then((value) => JSON.stringify(value));
  const created: Entry = { key, expiresAt: Date.now() + ttlMs, body };
  entries.set(list, created);
  // A failed build is never served to the next caller
  body.catch(() => {
    if (entries.get(list) === created) entries.delete(list);
  });
  return body;
}

/** Forget a cached list; call after (and before) every write to its collection. */
export function invalidateResponseCache(list: CachedList) {
  entries.delete(list);
}

/** Answer 200 with the cached list; same body and content type as res.json. */
export async function sendCachedJson(res: Response, list: CachedList, build: () => Promise<unknown>) {
  const body = await cachedJson(list, build);
  return res.status(200).set("Content-Type", "application/json; charset=utf-8").send(body);
}

/** Mongoose operations that write; registered as pre and post middleware to invalidate a cached list. */
const QUERY_WRITES = ["updateOne", "updateMany", "deleteOne", "deleteMany", "findOneAndUpdate", "findOneAndDelete", "findOneAndReplace", "replaceOne"] as const;

/**
 * Invalidate `list` on every write through this schema's model (document saves/deletes, query writes, insertMany,
 * bulkWrite). Before the write too, so a failed or partial write never leaves a stale entry for longer than its build.
 */
export function invalidateOnWrite(schema: mongoose.Schema, list: CachedList) {
  const invalidate = () => invalidateResponseCache(list);
  schema.pre([...QUERY_WRITES], { document: false, query: true }, invalidate);
  schema.post([...QUERY_WRITES], { document: false, query: true }, invalidate);
  schema.pre(["save", "deleteOne", "updateOne"], { document: true, query: false }, invalidate);
  schema.post(["save", "deleteOne", "updateOne"], { document: true, query: false }, invalidate);
  schema.pre("insertMany", invalidate);
  schema.post("insertMany", invalidate);
  schema.pre("bulkWrite", invalidate);
  schema.post("bulkWrite", invalidate);
}
