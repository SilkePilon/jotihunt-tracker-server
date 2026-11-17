import type mongoose from "mongoose";

/**
 * Short-lived memory of authenticated web sessions: session id → its user (lean, without read state). Every authed
 * request otherwise costs two sequential Mongo lookups (session, then user).
 *
 * Correctness comes from invalidation, not from the short TTL: every write to a session or a user through Mongoose
 * (save, update*, delete*, findOneAnd*, replaceOne, bulkWrite) drops the affected entries via the schema hooks in
 * `invalidateOnWrites`, an edition switch clears everything, and an entry never outlives its session's expiresAt.
 * The TTL only bounds writes that bypass Mongoose (raw collection access, another server process).
 */
export const SESSION_CACHE_TTL_MS = 15_000;
/** Bounds memory when many tokens are presented (the oldest entries go first). */
const MAX_ENTRIES = 5000;

interface Entry {
  userId: string;
  /** Lean user document, never handed out as is (callers hydrate a fresh document per request). */
  user: Record<string, unknown>;
  /** Cache expiry: min(now + TTL, session expiresAt) */
  until: number;
}

const entries = new Map<string, Entry>();
/** Bumped by every invalidation: a lookup that started before one may have read the old data and must not be cached. */
let epoch = 0;

/** Take this before the database lookups and pass it to cacheSession. */
export function sessionCacheEpoch() {
  return epoch;
}

export function getCachedSession(sessionId: string, now = Date.now()): { userId: string; user: Record<string, unknown> } | null {
  const entry = entries.get(sessionId);
  if (!entry) return null;
  if (entry.until <= now) {
    entries.delete(sessionId);
    return null;
  }
  return entry;
}

/** Remember a lookup, unless something was invalidated since `startEpoch` (it may have read data from before that write). */
export function cacheSession(
  sessionId: string,
  user: Record<string, unknown> & { _id: unknown },
  sessionExpiresAt: Date,
  startEpoch: number,
  now = Date.now(),
) {
  if (startEpoch !== epoch) return;
  if (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (!oldest.done) entries.delete(oldest.value);
  }
  entries.set(sessionId, { userId: String(user._id), user, until: Math.min(now + SESSION_CACHE_TTL_MS, sessionExpiresAt.getTime()) });
}

export function invalidateSession(sessionId: string) {
  epoch++;
  entries.delete(String(sessionId));
}

export function invalidateUserSessions(userId: unknown) {
  epoch++;
  const id = String(userId);
  for (const [sessionId, entry] of entries) if (entry.userId === id) entries.delete(sessionId);
}

export function clearSessionCache() {
  epoch++;
  entries.clear();
}

/** Tests only */
export function sessionCacheSize() {
  return entries.size;
}

/** The ids a filter value pins down (`id`, `{ $eq: id }`, `{ $in: [ids] }`), or null when it can match anything. */
function idsIn(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return [value];
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("$eq" in record) return idsIn(record.$eq);
    if (Array.isArray(record.$in)) return record.$in.map(String);
    // Any operator other than $eq/$in (e.g. $ne) can match more than one: give up
    if (Object.keys(record).some((key) => key.startsWith("$"))) return null;
    // An ObjectId (or another plain value with its own toString)
    return [String(value)];
  }
  return [String(value)];
}

type Kind = "user" | "session";

/** Drop the entries a write with this filter may have changed (everything when the filter is not narrow enough). */
function invalidateByFilter(kind: Kind, filter: Record<string, unknown> | undefined) {
  const ids = idsIn(filter?._id);
  if (ids) {
    for (const id of ids) (kind === "user" ? invalidateUserSessions : invalidateSession)(id);
    return;
  }
  const users = kind === "session" ? idsIn(filter?.user) : null;
  if (users) {
    for (const id of users) invalidateUserSessions(id);
    return;
  }
  clearSessionCache();
}

const QUERY_WRITES = [
  "updateOne",
  "updateMany",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "findOneAndUpdate",
  "findOneAndReplace",
  "findOneAndDelete",
] as const;

/**
 * Register hooks on a user or session schema (before its model is compiled) so every write through Mongoose
 * invalidates the cached entries it may touch. Invalidation runs before and after the write: a lookup racing the
 * write can't keep the old value cached.
 */
export function invalidateOnWrites(schema: mongoose.Schema, kind: Kind) {
  const byDoc = (doc: { _id?: unknown } | null | undefined) => {
    if (doc?._id === undefined) clearSessionCache();
    else invalidateByFilter(kind, { _id: doc._id });
  };
  for (const op of QUERY_WRITES) {
    schema.pre(op, function (this: mongoose.Query<unknown, unknown>) {
      invalidateByFilter(kind, this.getFilter());
    });
    schema.post(op, function (this: mongoose.Query<unknown, unknown>) {
      invalidateByFilter(kind, this.getFilter());
    });
  }
  schema.pre("save", function () {
    byDoc(this);
  });
  schema.post("save", function (doc: { _id?: unknown }) {
    byDoc(doc);
  });
  schema.post("deleteOne", { document: true, query: false }, function (doc: { _id?: unknown }) {
    byDoc(doc);
  });
  schema.pre("bulkWrite", function () {
    clearSessionCache();
  });
  schema.post("bulkWrite", function () {
    clearSessionCache();
  });
}
