import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { currentGeneration } from "../editions/work-tracking";

/**
 * Tiny in-memory cache of the JSON bodies of the polled list endpoints. Every hunter polls the same lists every few
 * seconds; within the TTL they all get the same serialised body instead of one query + build + stringify each.
 * Writes to a collection invalidate its entry (see the model middleware); entries are keyed by the database generation
 * and name, so an edition switch never serves the other database's data.
 */
export type CachedList = "markers" | "articles" | "hunts" | "hunt-counts";

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
export async function sendCachedJson(req: Request, res: Response, list: CachedList, build: () => Promise<unknown>) {
  return sendPreparedJson(req, res, `list:${list}`, await cachedJson(list, build));
}

const gzipAsync = promisify(gzip);
/** Same as the compression middleware: smaller bodies aren't worth compressing. */
export const GZIP_THRESHOLD_BYTES = 1024;

interface Prepared {
  body: string;
  etag: string;
  /** Made once, on the first request that accepts gzip */
  gzip?: Promise<Buffer>;
}

/** The last body sent per endpoint with its ETag and gzipped form, so polling never hashes or compresses it again. */
const prepared = new Map<string, Prepared>();

function prepare(endpoint: string, body: string): Prepared {
  const last = prepared.get(endpoint);
  // Cached bodies are the same string object until they change, so this is usually a pointer comparison
  if (last && last.body === body) return last;
  const etag = `W/"${Buffer.byteLength(body).toString(16)}-${createHash("sha1").update(body).digest("base64url").slice(0, 27)}"`;
  const entry: Prepared = { body, etag };
  prepared.set(endpoint, entry);
  return entry;
}

function acceptsGzip(req: Request): boolean {
  return typeof req.acceptsEncodings === "function" && req.acceptsEncodings("gzip", "identity") === "gzip";
}

/**
 * Send a prebuilt JSON body (a shared, memoised one) with a cached ETag: 304 when the client already has it, else the
 * body, gzipped once per body when the client accepts gzip (the compression middleware leaves an encoded body alone).
 * `endpoint` names the memo slot (one per endpoint).
 */
export async function sendPreparedJson(req: Request, res: Response, endpoint: string, body: string) {
  const entry = prepare(endpoint, body);
  res.set("Content-Type", "application/json; charset=utf-8");
  res.set("ETag", entry.etag);
  res.vary("Accept-Encoding");
  res.status(200);
  if (req.fresh) return res.status(304).end();
  if (Buffer.byteLength(body) < GZIP_THRESHOLD_BYTES || !acceptsGzip(req)) return res.send(body);
  if (!entry.gzip) {
    entry.gzip = gzipAsync(body);
    // A failed compression is tried again by the next request
    entry.gzip.catch(() => {
      if (prepared.get(endpoint) === entry) entry.gzip = undefined;
    });
  }
  let zipped: Buffer;
  try {
    zipped = await entry.gzip;
  } catch {
    return res.send(body);
  }
  res.set("Content-Encoding", "gzip");
  return res.send(zipped);
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
