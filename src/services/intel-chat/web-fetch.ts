import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { readCapped } from "../article-media";
import { htmlToText } from "../html-text";
import { ToolInputError } from "./tools/context";

export const PAGE_TIMEOUT_MS = 10_000;
export const PAGE_MAX_BYTES = 1024 * 1024;
export const PAGE_MAX_CHARS = 20_000;
const MAX_REDIRECTS = 3;
const TEXT_TYPES = ["text/html", "application/xhtml+xml", "text/plain", "application/json"];
const REQUEST_HEADERS = { Accept: "text/html,text/plain;q=0.9,*/*;q=0.1", "User-Agent": "JotihuntTracker/1.0 (intel chat)" };

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Lookup = (hostname: string) => Promise<string[]>;

const ipv4Number = (ip: string) => ip.split(".").reduce((value, part) => value * 256 + Number(part), 0);
const inV4 = (ip: string, base: string, bits: number) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipv4Number(ip) & mask) >>> 0) === ((ipv4Number(base) & mask) >>> 0);
};
const PRIVATE_V4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/** Loopback, private, link-local, CGNAT, multicast, reserved or unspecified (IPv4, IPv6 and IPv4-mapped IPv6) */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(ip) === 4) return PRIVATE_V4.some(([base, bits]) => inV4(ip, base, bits));
  if (isIP(ip) !== 6) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)?.[1];
  if (mapped) return isPrivateAddress(mapped);
  if (ip === "::" || ip === "::1") return true;
  const first = parseInt(ip.split(":")[0] || "0", 16);
  // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

const systemLookup: Lookup = async (hostname) => (await dnsLookup(hostname, { all: true })).map((entry) => entry.address);

/** The URL when it is http(s) on a host whose every address is public; ToolInputError otherwise */
export async function assertPublicUrl(raw: string, lookup: Lookup = systemLookup): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolInputError("Ongeldige URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ToolInputError("Alleen http(s)-adressen");
  if (url.username || url.password) throw new ToolInputError("Geen URL's met inloggegevens");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await lookup(host);
  } catch {
    throw new ToolInputError(`Kan ${host} niet vinden`);
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new ToolInputError("Dit adres is niet toegestaan (intern netwerk)");
  return url;
}

export interface WebPage {
  url: string;
  title: string | null;
  text: string;
  truncated: boolean;
}

/**
 * Read a public web page as plain text: http(s) only, every hop (redirects followed by hand, max 3) checked against
 * private addresses, 10 s, 1 MB, text types only, at most 20 000 characters.
 */
export async function readWebPage(raw: string, { fetch: fetchFn = fetch, lookup = systemLookup, signal }: { fetch?: Fetch; lookup?: Lookup; signal?: AbortSignal } = {}): Promise<WebPage> {
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(PAGE_TIMEOUT_MS)]) : AbortSignal.timeout(PAGE_TIMEOUT_MS);
  let url = await assertPublicUrl(raw, lookup);
  let response: Response;
  try {
    response = await fetchFn(url.toString(), { redirect: "manual", signal: deadline, headers: REQUEST_HEADERS });
    for (let hop = 0; response.status >= 300 && response.status < 400; hop++) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location || hop >= MAX_REDIRECTS) throw new ToolInputError("Te veel of ongeldige doorverwijzingen");
      url = await assertPublicUrl(new URL(location, url).toString(), lookup);
      response = await fetchFn(url.toString(), { redirect: "manual", signal: deadline, headers: REQUEST_HEADERS });
    }
  } catch (error) {
    if (error instanceof ToolInputError) throw error;
    throw new ToolInputError("Pagina niet bereikbaar");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ToolInputError(`Pagina gaf HTTP ${response.status}`);
  }
  const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!TEXT_TYPES.includes(type)) {
    await response.body?.cancel().catch(() => {});
    throw new ToolInputError(`Geen tekstpagina (${type || "onbekend type"})`);
  }
  const data = await readCapped(response, PAGE_MAX_BYTES).catch(() => null);
  if (!data) throw new ToolInputError("Pagina is groter dan 1 MB of brak af");
  const body = new TextDecoder().decode(data);
  const isHtml = type === "text/html" || type === "application/xhtml+xml";
  const title = isHtml ? (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? "").replace(/\s+/g, " ").trim() || null : null;
  const text = isHtml ? htmlToText(body) : body.trim();
  return { url: url.toString(), title, text: text.slice(0, PAGE_MAX_CHARS), truncated: text.length > PAGE_MAX_CHARS };
}
