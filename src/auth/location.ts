const regions = new Intl.DisplayNames(["nl"], { type: "region" });

/**
 * Rough location of a request from Cloudflare's visitor headers, for the QR confirm screen: "Arnhem", else
 * "Nederland"; null without Cloudflare (local runs) or for unknown/Tor addresses.
 */
export function approxLocation(header: (name: string) => string | undefined): string | null {
  const city = header("cf-ipcity")?.trim();
  if (city) return city.slice(0, 60);
  const country = header("cf-ipcountry")?.trim().toUpperCase();
  if (!country || !/^[A-Z]{2}$/.test(country) || country === "XX") return null;
  try {
    return regions.of(country) ?? null;
  } catch {
    return null;
  }
}
