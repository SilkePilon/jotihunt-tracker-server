const regions = new Intl.DisplayNames(["nl"], { type: "region", fallback: "none" });

/** True when the deployment sits behind Cloudflare (the same switch app.ts uses for the client IP). */
export const behindCloudflare = () => process.env.CLIENT_IP_HEADER?.trim().toLowerCase() === "cf-connecting-ip";

/**
 * Rough location of a request from Cloudflare's visitor headers, for the QR confirm screen: "Arnhem", else
 * "Nederland"; null when not behind Cloudflare (the headers could be forged), for local runs and for
 * unknown/Tor/unassigned codes.
 */
export function approxLocation(header: (name: string) => string | undefined, trustCloudflare: boolean): string | null {
  if (!trustCloudflare) return null;
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
