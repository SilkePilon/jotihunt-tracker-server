/** MongoDB E11000: a unique index rejected the write. */
export function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === 11000;
}

/** A 24 hex character ObjectId string (safe to pass to findById without a CastError). */
export function isObjectIdString(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{24}$/i.test(value);
}
