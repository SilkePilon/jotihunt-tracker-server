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
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/** The 8 hextets of a valid IPv6 address (a dotted IPv4 tail becomes the last two) */
function ipv6Hextets(ip: string): number[] {
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  let text = ip;
  if (dotted) {
    const v4 = ipv4Number(dotted[2]);
    text = `${dotted[1]}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const parse = (part: string | undefined) => (part ? part.split(":").map((hextet) => parseInt(hextet, 16)) : []);
  const left = parse(head);
  const right = parse(tail);
  return tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
}
const v4From = (high: number, low: number) => [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");

/**
 * Loopback, private, link-local, CGNAT, documentation, multicast, reserved or unspecified. IPv6 is normalised first;
 * forms embedding an IPv4 address (mapped, compatible, SIIT, NAT64, 6to4) are judged by that IPv4 address.
 */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(ip) === 4) return PRIVATE_V4.some(([base, bits]) => inV4(ip, base, bits));
  if (isIP(ip) !== 6) return true;
  const h = ipv6Hextets(ip);
  if (h.length !== 8 || h.some((hextet) => !Number.isInteger(hextet) || hextet < 0 || hextet > 0xffff)) return true;
  const zeros = (from: number, to: number) => h.slice(from, to).every((hextet) => hextet === 0);
  // ::/96 compatible (incl. :: and ::1), ::ffff:0:0/96 mapped, ::ffff:0:0:0/96 SIIT
  if (zeros(0, 5) && (h[5] === 0 || h[5] === 0xffff)) return isPrivateAddress(v4From(h[6], h[7]));
  if (zeros(0, 4) && h[4] === 0xffff && h[5] === 0) return isPrivateAddress(v4From(h[6], h[7]));
  // 64:ff9b::/96 NAT64
  if (h[0] === 0x64 && h[1] === 0xff9b && zeros(2, 6)) return isPrivateAddress(v4From(h[6], h[7]));
  // 2002::/16 6to4
  if (h[0] === 0x2002) return isPrivateAddress(v4From(h[1], h[2]));
  const first = h[0];
  return (
    zeros(0, 1) || // rest of ::/16 (reserved, discard 100::/64)
    (first === 0x64 && h[1] === 0xff9b) || // 64:ff9b:1::/48 local NAT64
    (first === 0x2001 && h[1] === 0) || // 2001::/32 Teredo
    (first === 0x2001 && h[1] === 0xdb8) || // 2001:db8::/32 documentation
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated)
    (first & 0xff00) === 0xff00 // ff00::/8 multicast
  );
}

const systemLookup: Lookup = async (hostname) => (await dnsLookup(hostname, { all: true })).map((entry) => entry.address);

/** The promise, or a ToolInputError as soon as the signal aborts */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  const unreachable = () => new ToolInputError("Pagina niet bereikbaar");
  if (signal.aborted) return Promise.reject(unreachable());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(unreachable());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** The URL when it is http(s) on a host whose every address is public; ToolInputError otherwise */
export async function assertPublicUrl(raw: string, lookup: Lookup = systemLookup, signal?: AbortSignal): Promise<URL> {
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
    addresses = isIP(host) ? [host] : await untilAborted(lookup(host), signal);
  } catch (error) {
    if (error instanceof ToolInputError) throw error;
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
 * private addresses, 10 s including DNS lookups, 1 MB, text types only, at most 20 000 characters.
 */
export async function readWebPage(raw: string, { fetch: fetchFn = fetch, lookup = systemLookup, signal }: { fetch?: Fetch; lookup?: Lookup; signal?: AbortSignal } = {}): Promise<WebPage> {
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(PAGE_TIMEOUT_MS)]) : AbortSignal.timeout(PAGE_TIMEOUT_MS);
  let url = await assertPublicUrl(raw, lookup, deadline);
  let response: Response;
  try {
    response = await fetchFn(url.toString(), { redirect: "manual", signal: deadline, headers: REQUEST_HEADERS });
    for (let hop = 0; response.status >= 300 && response.status < 400; hop++) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location || hop >= MAX_REDIRECTS) throw new ToolInputError("Te veel of ongeldige doorverwijzingen");
      url = await assertPublicUrl(new URL(location, url).toString(), lookup, deadline);
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
