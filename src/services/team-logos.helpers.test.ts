import { describe, expect, test } from "bun:test";
import { normalizeTeamName, parseTeamLogos } from "./team-logos.helpers";

const HTML = `
<li><div><span aria-hidden="true">S</span>
  <img
      src="https://cdn.jotihunt.net/jotihunt2026/media/32/conversions/groepslogo-alexandergroep-thumb.jpg"
      alt="Logo van Scouting Alexandergroep"
      loading="lazy" onerror="this.remove()" class="absolute" />
</div></li>
<li><img src="https://cdn.jotihunt.net/jotihunt2026/media/1/conversions/paddegat-thumb.jpg" alt="Logo van Jonkheer Schimmel &amp; Co&#039;s"></li>
<li><img src="https://jotihunt.nl/brave-character.png" alt=""></li>
<li><img src="/relative.png" alt="Logo van Relatief"></li>`;

describe("parseTeamLogos", () => {
  test("maps the group name from the alt text to the logo URL", () => {
    const logos = parseTeamLogos(HTML);
    expect(logos.get("scouting alexandergroep")).toBe("https://cdn.jotihunt.net/jotihunt2026/media/32/conversions/groepslogo-alexandergroep-thumb.jpg");
    expect(logos.get("jonkheer schimmel & co's")).toBe("https://cdn.jotihunt.net/jotihunt2026/media/1/conversions/paddegat-thumb.jpg");
  });

  test("skips images that are not group logos or not absolute https URLs", () => {
    expect([...parseTeamLogos(HTML).keys()]).toEqual(["scouting alexandergroep", "jonkheer schimmel & co's"]);
  });
});

describe("normalizeTeamName", () => {
  test("ignores case, extra whitespace and entities", () => {
    expect(normalizeTeamName("  Scouting   ALEXANDERgroep ")).toBe("scouting alexandergroep");
    expect(normalizeTeamName("Clubhuis &#039;t Paddegat")).toBe("clubhuis 't paddegat");
  });
});
