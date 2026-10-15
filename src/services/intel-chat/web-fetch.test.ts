import { describe, expect, test } from "bun:test";
import { mockModel } from "../../test/ai";
import { runTool } from "../../test/tools";
import { webTools } from "./tools/web";
import { assertPublicUrl, isPrivateAddress, readWebPage } from "./web-fetch";

const publicDns = async () => ["93.184.216.34"];

function fakeFetch(routes: Record<string, () => Response>) {
  const urls: string[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    urls.push(url);
    expect(init.redirect).toBe("manual");
    const route = routes[url];
    if (!route) throw new TypeError("fetch failed");
    return route();
  };
  return { fetch, urls };
}
const html = (body: string, headers: Record<string, string> = {}) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...headers } });

describe("isPrivateAddress", () => {
  test("private, loopback, link-local, CGNAT, multicast and mapped addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "nonsense"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });

  test("public addresses", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  test("refuses other schemes, credentials, private IP literals and hosts resolving to a private address", async () => {
    await expect(assertPublicUrl("file:///etc/passwd", publicDns)).rejects.toThrow("Alleen http(s)-adressen");
    await expect(assertPublicUrl("ftp://example.org/x", publicDns)).rejects.toThrow("Alleen http(s)-adressen");
    await expect(assertPublicUrl("http://user:pw@example.org/", publicDns)).rejects.toThrow("Geen URL's met inloggegevens");
    await expect(assertPublicUrl("http://127.0.0.1:27017/", publicDns)).rejects.toThrow("niet toegestaan");
    await expect(assertPublicUrl("http://[::1]/", publicDns)).rejects.toThrow("niet toegestaan");
    await expect(assertPublicUrl("http://intern.example/", async () => ["93.184.216.34", "10.0.0.5"])).rejects.toThrow("niet toegestaan");
    await expect(assertPublicUrl("http://weg.example/", async () => Promise.reject(new Error("ENOTFOUND")))).rejects.toThrow("Kan weg.example niet vinden");
    expect((await assertPublicUrl("https://example.org/a", publicDns)).hostname).toBe("example.org");
  });
});

describe("readWebPage", () => {
  test("html becomes text with the title", async () => {
    const { fetch } = fakeFetch({ "https://example.org/a": () => html("<html><head><title> Brave </title></head><body><p>Merida</p><script>x()</script></body></html>") });
    expect(await readWebPage("https://example.org/a", { fetch, lookup: publicDns })).toEqual({ url: "https://example.org/a", title: "Brave", text: "Brave Merida", truncated: false });
  });

  test("follows a public redirect, refuses a redirect to a private host", async () => {
    const lookup = async (host: string) => (host === "evil.example" ? ["192.168.1.10"] : ["93.184.216.34"]);
    const { fetch } = fakeFetch({
      "https://example.org/old": () => new Response(null, { status: 301, headers: { location: "/new" } }),
      "https://example.org/new": () => html("<p>nieuw</p>"),
      "https://example.org/bad": () => new Response(null, { status: 302, headers: { location: "http://evil.example/admin" } }),
    });
    expect((await readWebPage("https://example.org/old", { fetch, lookup })).text).toBe("nieuw");
    await expect(readWebPage("https://example.org/bad", { fetch, lookup })).rejects.toThrow("niet toegestaan");
  });

  test("every redirect hop is checked before it is fetched, and at most 3 redirects are followed", async () => {
    const { fetch, urls } = fakeFetch({
      "https://example.org/1": () => new Response(null, { status: 302, headers: { location: "https://example.org/2" } }),
      "https://example.org/2": () => new Response(null, { status: 307, headers: { location: "http://169.254.169.254/latest/meta-data" } }),
      "https://example.org/a": () => new Response(null, { status: 301, headers: { location: "/b" } }),
      "https://example.org/b": () => new Response(null, { status: 301, headers: { location: "/c" } }),
      "https://example.org/c": () => new Response(null, { status: 301, headers: { location: "/d" } }),
      "https://example.org/d": () => new Response(null, { status: 301, headers: { location: "/e" } }),
      "https://example.org/e": () => html("<p>te ver</p>"),
    });
    await expect(readWebPage("https://example.org/1", { fetch, lookup: publicDns })).rejects.toThrow("niet toegestaan");
    expect(urls).toEqual(["https://example.org/1", "https://example.org/2"]);
    urls.length = 0;
    await expect(readWebPage("https://example.org/a", { fetch, lookup: publicDns })).rejects.toThrow("Te veel of ongeldige doorverwijzingen");
    expect(urls).toEqual(["https://example.org/a", "https://example.org/b", "https://example.org/c", "https://example.org/d"]);
  });

  test("non-text types, errors, too large and long pages", async () => {
    const { fetch } = fakeFetch({
      "https://example.org/img": () => new Response("x", { headers: { "content-type": "image/png" } }),
      "https://example.org/404": () => new Response("nope", { status: 404 }),
      "https://example.org/big": () => new Response("a".repeat(1024 * 1024 + 1), { headers: { "content-type": "text/plain" } }),
      "https://example.org/long": () => new Response("b".repeat(25_000), { headers: { "content-type": "text/plain" } }),
    });
    await expect(readWebPage("https://example.org/img", { fetch, lookup: publicDns })).rejects.toThrow("Geen tekstpagina (image/png)");
    await expect(readWebPage("https://example.org/404", { fetch, lookup: publicDns })).rejects.toThrow("Pagina gaf HTTP 404");
    await expect(readWebPage("https://example.org/big", { fetch, lookup: publicDns })).rejects.toThrow("groter dan 1 MB");
    await expect(readWebPage("https://example.org/down", { fetch, lookup: publicDns })).rejects.toThrow("Pagina niet bereikbaar");
    const long = await readWebPage("https://example.org/long", { fetch, lookup: publicDns });
    expect(long.text).toHaveLength(20_000);
    expect(long.truncated).toBe(true);
  });

  test("the readWebPage tool returns { error } for a refused URL", async () => {
    const tools = webTools({ articleId: 1, now: () => new Date(), toolModel: mockModel(() => ""), lookup: async () => ["127.0.0.1"], fetch: fakeFetch({}).fetch });
    expect(await runTool(tools.readWebPage, { url: "http://localhost:3000/admin" })).toEqual({ error: "Dit adres is niet toegestaan (intern netwerk)" });
  });
});
