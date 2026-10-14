import { describe, expect, test } from "bun:test";
import { articleAttachments, articleImages, fetchImages, type ArticleImage } from "./article-media";

const trixImage = (filename: string, url: string) =>
  `<figure data-trix-attachment="{&quot;contentType&quot;:&quot;image/png&quot;,&quot;filename&quot;:&quot;${filename}&quot;,&quot;url&quot;:&quot;${url}&quot;}" class="attachment attachment--preview">` +
  `<img src="${url}"><figcaption class="attachment__caption"><span class="attachment__name">${filename}</span></figcaption></figure>`;

describe("articleImages", () => {
  test("loose images and Trix image attachments in document order, named by filename, alt or URL", () => {
    const html =
      `<div>Kijk:<img src="https://cdn.jotihunt.net/a.png" alt="Kaart"></div>` +
      `<div>${trixImage("Hint Oscar.png", "https://cdn.jotihunt.net/NEL.png")}</div>` +
      `<div><img src="https://cdn.jotihunt.net/files/c.jpg?w=2"></div>`;
    expect(articleImages(html)).toEqual([
      { url: "https://cdn.jotihunt.net/a.png", name: "Kaart" },
      { url: "https://cdn.jotihunt.net/NEL.png", name: "Hint Oscar.png" },
      { url: "https://cdn.jotihunt.net/files/c.jpg?w=2", name: "c.jpg" },
    ]);
  });

  test("a Trix figure without JSON uses its inner img and caption name", () => {
    const html = `<figure><img src="https://x.nl/1.png"><figcaption><span class="attachment__name">Bravo.png</span></figcaption></figure>`;
    expect(articleImages(html)).toEqual([{ url: "https://x.nl/1.png", name: "Bravo.png" }]);
  });

  test("a Trix image attachment without an img uses its url", () => {
    const html = `<figure data-trix-attachment="{&quot;filename&quot;:&quot;plaat.jpg&quot;,&quot;href&quot;:&quot;https://x.nl/plaat.jpg&quot;}"></figure>`;
    expect(articleImages(html)).toEqual([{ url: "https://x.nl/plaat.jpg", name: "plaat.jpg" }]);
  });

  test("deduplicates by URL, skips relative, data and other non-http(s) URLs, and file attachments", () => {
    const html =
      `<img src="https://x.nl/a.png"><img src="https://x.nl/a.png" alt="nog eens">` +
      `<img src="/local/b.png"><img src="data:image/png;base64,AAAA"><img src="javascript:alert(1)"><img src="ftp://x.nl/c.png">` +
      `<figure data-trix-attachment="{&quot;contentType&quot;:&quot;application/zip&quot;,&quot;filename&quot;:&quot;alpha.zip&quot;}"><a href="https://x.nl/alpha.zip"></a></figure>` +
      `<img data-src="https://x.nl/lazy.png">`;
    expect(articleImages(html)).toEqual([{ url: "https://x.nl/a.png", name: "a.png" }]);
  });

  test("an HTML-encoded URL is decoded", () => {
    expect(articleImages(`<img src="https://x.nl/a.png?w=1&amp;h=2">`)[0].url).toBe("https://x.nl/a.png?w=1&h=2");
  });
});

describe("articleAttachments", () => {
  test("names of non-image Trix attachments, once each", () => {
    const zip = `<figure data-trix-attachment="{&quot;contentType&quot;:&quot;application/zip&quot;,&quot;filename&quot;:&quot;alpha.zip&quot;}"><a href="https://x.nl/1.zip"></a></figure>`;
    const pdf = `<figure class="attachment attachment--file"><a href="https://x.nl/files/regels.pdf"></a></figure>`;
    expect(articleAttachments(zip + pdf + zip + trixImage("p.png", "https://x.nl/p.png"))).toEqual(["alpha.zip", "regels.pdf"]);
  });
});

describe("fetchImages", () => {
  const images = (count: number): ArticleImage[] => Array.from({ length: count }, (_, index) => ({ url: `https://x.nl/${index}.png`, name: `${index}.png` }));
  const png = (size: number, headers: Record<string, string> = {}) => new Response(new Uint8Array(size).fill(1), { headers: { "content-type": "image/png", ...headers } });

  test("downloads in order with the media type and name", async () => {
    const seen: string[] = [];
    const result = await fetchImages(images(3), {
      fetch: async (url) => {
        seen.push(url);
        return url.endsWith("1.png") ? new Response(new Uint8Array([7]), { headers: { "content-type": "image/JPEG; charset=x" } }) : png(2);
      },
    });
    expect(result.map((image) => [image.name, image.mediaType, image.data.byteLength])).toEqual([
      ["0.png", "image/png", 2],
      ["1.png", "image/jpeg", 1],
      ["2.png", "image/png", 2],
    ]);
    expect(seen.sort()).toEqual(["https://x.nl/0.png", "https://x.nl/1.png", "https://x.nl/2.png"]);
  });

  test("at most 20 images by default", async () => {
    expect(await fetchImages(images(25), { fetch: async () => png(1) })).toHaveLength(20);
  });

  test("skips an image over the per-image limit (by content-length and by actual size)", async () => {
    const result = await fetchImages(images(3), {
      maxBytesEach: 10,
      fetch: async (url) => {
        if (url.endsWith("0.png")) return png(5, { "content-length": "11" });
        if (url.endsWith("1.png")) return png(11);
        return png(10);
      },
    });
    expect(result.map((image) => image.name)).toEqual(["2.png"]);
  });

  test("stops adding once the total budget is reached", async () => {
    const result = await fetchImages(images(4), { maxBytesTotal: 25, fetch: async () => png(10) });
    expect(result.map((image) => image.name)).toEqual(["0.png", "1.png"]);
  });

  test("skips non-image content types, failed requests, errors and timeouts", async () => {
    const result = await fetchImages(images(5), {
      timeoutMs: 50,
      fetch: async (url, init) => {
        if (url.endsWith("0.png")) return new Response("<html>", { headers: { "content-type": "text/html" } });
        if (url.endsWith("1.png")) return new Response("nee", { status: 404, headers: { "content-type": "image/png" } });
        if (url.endsWith("2.png")) throw new TypeError("fetch failed");
        if (url.endsWith("3.png"))
          return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError"))));
        return png(3, { "content-type": "image/svg+xml" });
      },
    });
    expect(result).toEqual([]);
  });

  test("never requests a non-http(s) URL; a redirect ending elsewhere is skipped", async () => {
    const seen: string[] = [];
    const result = await fetchImages(
      [
        { url: "file:///etc/passwd", name: "x" },
        { url: "https://x.nl/r.png", name: "r" },
      ],
      {
        fetch: async (url) => {
          seen.push(url);
          const response = png(1);
          Object.defineProperty(response, "url", { value: "file:///etc/passwd" });
          return response;
        },
      },
    );
    expect(seen).toEqual(["https://x.nl/r.png"]);
    expect(result).toEqual([]);
  });
});
