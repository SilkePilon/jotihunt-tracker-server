import { areaTitle, type AreaName } from "../../constants/areas";
import type { ItemView } from "./tools/app-data";

const KIND_LABEL = { hint: "hint", opdracht: "opdracht", nieuws: "nieuwsbericht" } as const;

/** "zaterdag 17 oktober 14:05" in Dutch time */
export function dutchDateTime(date: Date): string {
  const day = date.toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Amsterdam" });
  const time = date.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Amsterdam" });
  return `${day} ${time}`;
}

/** The Jotihunt rules the assistant needs, distilled from docs/02-game-rules.md and docs/04-hints-and-puzzles.md */
export const GAME_RULES = `## Het spel in het kort
- Jotihunt 2026: za 17 okt 10:00 tot zo 18 okt 12:00, in Gelderland. Thema: BRAVE (Pixar) en Schotland. HQ Jotihunt: Stikkerstraat 10, Arnhem (RD 188362 440722).
- Negen vossenteams (deelgebieden): Alpha, Bravo, Charlie, Delta, Echo, Foxtrot, Golf, Hotel en Oscar. Vossen lopen te voet (ongeveer 4-5 km/u) langs de scoutinggroepen van hun deelgebied; Oscar reist waarschijnlijk met het OV.
- Status van een vos: groen = actief (huntbaar), oranje = onderweg (nog huntbaar), rood = inactief (niet huntbaar). Rond 23:00 wisselen de teams (22:45-23:15 inactief).
- Hunt: fysiek contact met de vossen, huntcode binnen 30 minuten invoeren met tijd en foto. Daarna 1 uur dezelfde vos niet hunten. Ons eigen (hoofd)vossenteam: 6 punten, andere toegestane vossen: 3, niet toegestane vossen: 0.
- Hints: elk uur een hint met een gezamenlijke intro en per deelgebied een gecodeerd deel. "-" of "--" betekent geen hint voor dat deelgebied dit uur. Een volledig goed antwoord binnen 20 minuten = 1 punt per vossenteam; foute antwoorden worden niet verbeterd.
- Het antwoord is meestal een RD-coördinaat (Rijksdriehoek, meters) in 8 cijfers "XXXX YYYY" = hectometers: 188362 440722 wordt "1884 4407". In Gelderland begint X met 1 of 2 (ongeveer 1400-2500) en Y met 4 (ongeveer 4150-5100); zo zie je snel of iets omgedraaid of fout is. Soms is het antwoord een woord, postcode of codewoord: lees de omschrijving van de hint goed.
- Een hintcoördinaat is waar de vossen wáren op het meldmoment (het hele uur), niet waar ze nu zijn.
- Opdrachten: max. punten en een deadline, één inzending (foto, tekst of YouTube-link). Het groepslogo of de vlag moet zichtbaar zijn; foto's liggend, JPG of PNG, max 2 MB, niet digitaal bewerkt tenzij toegestaan.
- Bekende puzzeltypes: Caesar/ROT, Morse, Braille en Elia, binair, 7-segment, weerstandskleurcode, KIX-code, Hexahue, Color Tokki, KennyCode, anagrammen, filippines, getallen in woorden (ook in andere of verzonnen talen, bv. Schots-Gaelisch aon, dhà, trì, ceithir, còig, sia, seachd, ochd, naoi, neoni), Ogham, Tengwar, stapeltellen (cijfersom tot 1 cijfer), trivia waarbij elk antwoord een cijfer geeft, afstand + richting vanaf HQ Jotihunt (coördinatenprojectie), kruispeiling, postcodes en adressen die lijnen of cijfers op de kaart tekenen, wachtwoorden voor .docx/.zip die uit de puzzel zelf komen (nooit brute-forcen).`;

function itemSection(item: ItemView, attachedImages: string[]): string {
  const lines = [`Soort: ${KIND_LABEL[item.kind]}`, `Titel: ${item.title}`, `Id: ${item.articleId}`, `Gepubliceerd: ${dutchDateTime(new Date(item.publishAt))}`];
  if (item.endTime) lines.push(`Deadline: ${dutchDateTime(new Date(item.endTime))}`);
  if (item.maxPoints !== null) lines.push(`Max punten: ${item.maxPoints}`);
  if (item.summary) lines.push(`Samenvatting: ${item.summary}`);
  if (item.attachments.length > 0) lines.push(`Bijlagen (niet leesbaar voor jou): ${item.attachments.join(", ")}`);
  if (item.images.length > 0) {
    const notAttached = item.images.map((image) => image.name).filter((name) => !attachedImages.includes(name));
    if (attachedImages.length > 0) lines.push(`Afbeeldingen van het item, in deze volgorde bijgevoegd bij het eerste bericht: ${attachedImages.join(", ")}`);
    if (notAttached.length > 0) lines.push(`Afbeeldingen die je niet kunt zien: ${notAttached.join(", ")}`);
  }
  lines.push("Tekst:", item.text || "(geen tekst)");
  if (item.hintCells.length > 0) {
    lines.push("Hintvakken:");
    for (const cell of item.hintCells) {
      const name = areaTitle(cell.area as AreaName);
      const status = cell.status === "solved" ? `opgelost, antwoord "${cell.answer ?? ""}"` : cell.status === "none" ? "geen hint" : "open";
      lines.push(`- ${name}: ${status}${cell.snippet ? ` | deel: ${cell.snippet.replace(/\n/g, " / ")}` : ""}`);
    }
  }
  return lines.join("\n");
}

/** The Dutch system prompt of one chat turn */
export function buildSystemPrompt({ item, now, web, attachedImages }: { item: ItemView; now: Date; web: boolean; attachedImages: string[] }): string {
  const webRule = web
    ? "- Internet staat aan: gebruik webSearch voor feiten die je niet zeker weet en noem je bronnen kort."
    : '- Internet staat uit. Moet je iets opzoeken, zeg dan dat de gebruiker "Web" kan aanzetten.';
  return `Je bent de puzzel- en kaartassistent van het hoofdkwartier (HQ) van een scoutinggroep tijdens de Jotihunt. Je helpt een teamlid met het item dat nu open staat in het Intel-venster.

${GAME_RULES}

## Nu
${dutchDateTime(now)}

## Het open item
${itemSection(item, attachedImages)}

## Regels
- Antwoord kort en in het Nederlands. Markdown alleen voor korte lijstjes of een tabelletje.
- Gebruik je tools in plaats van te gokken: getItem, searchIntel, getHintBoard en getAreas voor gegevens uit de app; convertCoordinates voor elke omrekening van coördinaten.
${webRule}
- Zeg het duidelijk als iets een schatting of aanname is. Een deelgebied uit checkPoint is alleen zeker als method "hull" is; anders noem je het een schatting.
- Je kunt niets opslaan of wijzigen. Zeg nooit dat je iets hebt opgeslagen of ingevuld; de gebruiker doet dat zelf met de knop op het kaartje.
- Heb je een kandidaat-punt: roep altijd eerst checkPoint aan en eindig met showPoint, of met proposeHintAnswer als het een antwoord op een hintvak van dit item is.
- Leg in 1-3 zinnen uit hoe je tot een antwoord kwam (welke techniek). Weet je het niet zeker, zeg dat en geef de beste kandidaten.`;
}
