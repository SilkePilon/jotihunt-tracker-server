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
});
