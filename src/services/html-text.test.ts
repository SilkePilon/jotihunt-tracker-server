import { describe, expect, test } from "bun:test";
import { htmlToText } from "./html-text";

describe("htmlToText", () => {
  test("drops tags, keeps line breaks of blocks and list items", () => {
    expect(htmlToText("<div><strong>Let op!</strong><br>Wissel om 23:00.</div><ul><li>een</li><li>twee</li></ul>")).toBe("Let op!\nWissel om 23:00.\n- een\n- twee");
  });

  test("decodes the common entities", () => {
    expect(htmlToText("<div>Vis &amp; friet &lt;3 &quot;ja&quot; &#39;nee&#39;&nbsp;ok</div>")).toBe("Vis & friet <3 \"ja\" 'nee' ok");
  });

  test("replaces an image by a marker and drops attachment captions' markup", () => {
    expect(htmlToText('<div>Kijk:</div><figure data-trix-attachment="{&quot;url&quot;:&quot;x&quot;}"><img src="https://cdn.jotihunt.net/a.png"><figcaption>kaart</figcaption></figure>')).toBe("Kijk:\n[afbeelding]\nkaart");
  });

  test("collapses blank lines and trims", () => {
    expect(htmlToText("<div><br><br></div><div>  a  </div><div></div><div>b</div>")).toBe("a\nb");
  });

  test("decodes numeric entities, the euro sign and the ellipsis", () => {
    expect(htmlToText("<div>&#8364;5 of &#x20AC;6 of &euro;7&hellip; caf&#233;</div>")).toBe("€5 of €6 of €7… café");
  });

  test("decodes entities once: an escaped entity stays text", () => {
    expect(htmlToText("<div>&amp;lt; en &amp;#8364;</div>")).toBe("&lt; en &#8364;");
  });

  test("leaves an unknown or impossible entity as it is", () => {
    expect(htmlToText("<div>&foo; &#x110000; &#0;</div>")).toBe("&foo; &#x110000; &#0;");
  });

  test("drops the contents of script and style", () => {
    expect(htmlToText('<style type="text/css">div { color: red }</style><div>Tekst</div><script>alert("x")</script><SCRIPT>\nvar a = 1;\n</SCRIPT>')).toBe("Tekst");
  });

  test("drops file name and size of an attachment caption, keeps a written caption", () => {
    const figure = (caption: string) => `<figure class="attachment attachment--preview"><img src="https://cdn.jotihunt.net/a.png"><figcaption class="attachment__caption">${caption}</figcaption></figure>`;
    expect(htmlToText(figure('<span class="attachment__name">image.png</span> <span class="attachment__size">112.65 KB</span>'))).toBe("[afbeelding]");
    expect(htmlToText(figure("De kaart van Charlie"))).toBe("[afbeelding]\nDe kaart van Charlie");
  });
});
