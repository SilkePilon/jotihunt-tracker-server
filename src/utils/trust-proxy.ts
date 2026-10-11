/** Parses TRUST_PROXY: "true"/"false" -> boolean, "2" -> hop count, anything else (e.g. "loopback, 10.0.0.0/8") stays a string. */
export function parseTrustProxy(value: string): boolean | number | string {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}
