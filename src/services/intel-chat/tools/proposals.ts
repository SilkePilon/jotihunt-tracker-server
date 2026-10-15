import { jsonSchema, tool } from "ai";
import { AREAS, areaTitle, knownAreaName } from "../../../constants/areas";
import { HintCell } from "../../../models/hint-cell.model";
import { formatRdAnswer, parseRdAnswer } from "../../rd-answer";
import { loadGroups } from "../data";
import { parseCoordinate } from "../geo";
import { pointResult, type PointResult } from "../point";
import { findPublicArticle } from "./app-data";
import { safely, ToolInputError, type IntelToolContext } from "./context";
import { POINT_DESCRIPTION, readPoint } from "./map";

/** proposeHintAnswer output (contract: HintAnswerProposal) */
export interface HintAnswerProposal {
  articleId: number;
  area: string;
  answer: string;
  kind: "rd" | "text";
  point: PointResult | null;
}

const MAX_ANSWER = 200;

/**
 * The answer as "Zet als antwoord" will post it. An answer parseRdAnswer reads (what POST /hints/.../solve stores as a
 * coordinate) stays as typed; another coordinate notation becomes the 8-digit RD answer; anything else is a word.
 */
export function normaliseAnswer(answer: string): { answer: string; kind: "rd" | "text"; rd: ReturnType<typeof parseRdAnswer> } {
  const trimmed = String(answer ?? "").trim();
  if (!trimmed || trimmed.length > MAX_ANSWER) throw new ToolInputError("Antwoord moet 1 tot 200 tekens zijn");
  const rd = parseRdAnswer(trimmed);
  if (rd) return { answer: trimmed, kind: "rd", rd };
  const parsed = parseCoordinate(trimmed);
  if (parsed) {
    const asRd = formatRdAnswer(parsed.latLng.lng, parsed.latLng.lat);
    return { answer: asRd, kind: "rd", rd: parseRdAnswer(asRd) };
  }
  return { answer: trimmed, kind: "text", rd: null };
}

export function proposalTools(ctx: IntelToolContext) {
  return {
    showPoint: tool({
      description: "Zet een punt klaar als kaart-kaartje voor de gebruiker (met knop 'Toon op kaart'). Gebruik dit om een gevonden of berekend punt te laten zien. Slaat niets op.",
      inputSchema: jsonSchema<{ point: string; label: string }>({
        type: "object",
        properties: { point: { type: "string", description: POINT_DESCRIPTION }, label: { type: "string", description: "Korte naam voor het punt (max 80 tekens)" } },
        required: ["point", "label"],
      }),
      execute: ({ point, label }) => safely("showPoint", async () => pointResult(readPoint(point), String(label ?? ""), await loadGroups())),
    }),
    proposeHintAnswer: tool({
      description:
        "Stel een antwoord voor op een hintvak van het open hint-item. De gebruiker ziet een kaartje met de knop 'Zet als antwoord'; alleen die klik slaat het op. Een coördinaat wordt het 8-cijferige RD-antwoord, tenzij je al RD gaf.",
      inputSchema: jsonSchema<{ area: string; answer: string }>({
        type: "object",
        properties: { area: { type: "string", enum: [...AREAS], description: "Deelgebied van het hintvak" }, answer: { type: "string", description: "Het antwoord: RD-coördinaat of woord" } },
        required: ["area", "answer"],
      }),
      execute: ({ area, answer }) =>
        safely("proposeHintAnswer", async (): Promise<HintAnswerProposal> => {
          const key = knownAreaName(area);
          if (!key) throw new ToolInputError(`Onbekend deelgebied: ${area}`);
          const article = await findPublicArticle(ctx.articleId);
          if (!article || article.type !== "hint") throw new ToolInputError("Het open item is geen hint");
          if (!(await HintCell.exists({ articleId: ctx.articleId, area: key }))) throw new ToolInputError(`Deze hint heeft geen vak voor ${areaTitle(key)}`);
          const normalised = normaliseAnswer(answer);
          const point = normalised.rd ? pointResult({ kind: "rd", rd: { x: normalised.rd.x, y: normalised.rd.y }, latLng: { lat: normalised.rd.lat, lng: normalised.rd.lng } }, `${areaTitle(key)}: ${normalised.answer}`, await loadGroups()) : null;
          return { articleId: ctx.articleId, area: key, answer: normalised.answer, kind: normalised.kind, point };
        }),
    }),
  };
}
