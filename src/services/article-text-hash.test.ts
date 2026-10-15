import { describe, expect, test } from "bun:test";
import { articleTextHash } from "./article-text-hash";

describe("articleTextHash", () => {
  const base = '<div>Om <strong>23:00</strong> wisselen de vossen.</div><figure data-trix-attachment="{&quot;url&quot;:&quot;https://cdn.jotihunt.net/a.png&quot;}"><img src="https://cdn.jotihunt.net/a.png"></figure>';

  test("is a sha256 hex digest", () => {
    expect(articleTextHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("formatting-only changes (tags, attributes, whitespace, line breaks) keep the hash", () => {
    const reformatted =
      '<div class="trix-content">\n  Om   <em>23:00</em>\n wisselen de <span>vossen.</span></div>\n<figure class="attachment" data-trix-attachment="{&quot;url&quot;:&quot;https://cdn.jotihunt.net/a.png&quot;}"><img width="200" src="https://cdn.jotihunt.net/a.png"></figure>';
    expect(articleTextHash(reformatted)).toBe(articleTextHash(base));
    expect(articleTextHash("<div>a</div><div>b</div>")).toBe(articleTextHash("<div>a<br>b</div>"));
  });

  test("a text change changes the hash", () => {
    expect(articleTextHash(base.replace("23:00", "22:00"))).not.toBe(articleTextHash(base));
  });

  test("another image changes the hash; their order does not", () => {
    expect(articleTextHash(base.replaceAll("a.png", "b.png"))).not.toBe(articleTextHash(base));
    const two = (first: string, second: string) => `<div>Kaart</div><img src="https://cdn.jotihunt.net/${first}"><img src="https://cdn.jotihunt.net/${second}">`;
    expect(articleTextHash(two("a.png", "b.png"))).toBe(articleTextHash(two("b.png", "a.png")));
  });

  test("another attached file changes the hash", () => {
    const file = (name: string) => `<div>Zie bijlage</div><figure data-trix-attachment="{&quot;filename&quot;:&quot;${name}&quot;,&quot;contentType&quot;:&quot;application/pdf&quot;}"><a href="https://cdn.jotihunt.net/${name}">x</a></figure>`;
    expect(articleTextHash(file("route.pdf"))).not.toBe(articleTextHash(file("kaart.pdf")));
  });

  test("image refs are hashed by file name: signature and host changes keep the hash", () => {
    const img = (ref: string) => `<div>Kaart</div><img src="${ref}">`;
    const a = articleTextHash(img("https://jotihunt.nl/bericht-afbeeldingen/digitalocean/abc.png?signature=aaaa"));
    expect(articleTextHash(img("https://jotihunt.nl/bericht-afbeeldingen/digitalocean/abc.png?signature=bbbb"))).toBe(a);
    expect(articleTextHash(img("https://cdn.jotihunt.net/bericht-afbeeldingen/digitalocean/ABC.png?signature=cccc"))).toBe(a);
    expect(articleTextHash(img("https://jotihunt.nl/bericht-afbeeldingen/digitalocean/def.png?signature=aaaa"))).not.toBe(a);
  });

  test("zero-width characters do not change the hash", () => {
    expect(articleTextHash("<div>Wis\u200bsel om 23:00\ufeff</div>")).toBe(articleTextHash("<div>Wissel om 23:00</div>"));
  });
});
