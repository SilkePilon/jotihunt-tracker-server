import { createHash } from "node:crypto";

/** Hex SHA-256; secrets in links are only stored hashed. */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
