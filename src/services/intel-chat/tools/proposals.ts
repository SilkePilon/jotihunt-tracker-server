import { jsonSchema, tool } from "ai";
import { AREAS, areaTitle, knownAreaName } from "../../../constants/areas";
import { AssignmentStatus } from "../../../models/assignment.model";
import { HintCell } from "../../../models/hint-cell.model";
import { formatRdAnswer, parseRdAnswer } from "../../rd-answer";
import { loadGroups } from "../data";
import { parseCoordinate } from "../geo";
import { pointResult, type PointResult } from "../point";
import { findAssignmentArticle, findPublicArticle } from "./app-data";
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

/** proposeAssignmentUpdate output (contract: AssignmentProposal) */
export interface AssignmentProposal {
  articleId: number;
  title: string;
  status?: AssignmentStatus;
  note?: string;
}

const MAX_ANSWER = 200;
const MAX_NOTE = 1000;
const ASSIGNMENT_STATUSES = Object.values(AssignmentStatus) as string[];

/** A status change and/or note for an assignment as the "Opslaan" card will post it; nothing is written */
export async function assignmentProposal(articleId: number, status: unknown, note: unknown): Promise<AssignmentProposal> {
  const article = await findAssignmentArticle(articleId);
  const hasStatus = status !== undefined && status !== null && status !== "";
  const hasNote = note !== undefined && note !== null && note !== "";
  if (!hasStatus && !hasNote) throw new ToolInputError("Geef een status of een notitie");
  if (hasStatus && !ASSIGNMENT_STATUSES.includes(String(status))) throw new ToolInputError(`Onbekende status: ${String(status).slice(0, 40)} (open, busy, submitted of skipped)`);
  const text = hasNote ? String(note).trim() : "";
  if (hasNote && (!text || text.length > MAX_NOTE)) throw new ToolInputError("Notitie moet 1 tot 1000 tekens zijn");
  return { articleId, title: article.title, ...(hasStatus ? { status: status as AssignmentStatus } : {}), ...(hasNote ? { note: text } : {}) };
}

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
    proposeAssignmentUpdate: tool({
      description:
        "Stel een nieuwe status en/of een notitie voor bij een opdracht. De gebruiker ziet een kaartje met de knop 'Opslaan'; alleen die klik slaat het op. Zonder articleId: het open item.",
      inputSchema: jsonSchema<{ articleId?: number; status?: string; note?: string }>({
        type: "object",
        properties: {
          articleId: { type: "integer", description: "Id van een andere opdracht; weglaten voor het open item" },
          status: { type: "string", enum: ASSIGNMENT_STATUSES, description: "open, busy (bezig), submitted (ingeleverd) of skipped (overgeslagen)" },
          note: { type: "string", description: "Notitie (max 1000 tekens)" },
        },
      }),
      execute: ({ articleId, status, note }) => safely("proposeAssignmentUpdate", () => assignmentProposal(articleId ?? ctx.articleId, status, note)),
    }),
  };
}
