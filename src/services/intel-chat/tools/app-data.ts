import { jsonSchema, tool } from "ai";
import { AREAS, knownAreaName, type AreaName } from "../../../constants/areas";
import { groupConfig } from "../../../auth/config";
import { Area } from "../../../models/area.model";
import { Article, publicArticlesFilter } from "../../../models/article.model";
import { HintCell, HintCellStatus } from "../../../models/hint-cell.model";
import { Team } from "../../../models/team.model";
import { getHuntableAreas } from "../../../settings/huntable-areas-setting";
import { articleAttachments, articleImages } from "../../article-media";
import { htmlToText } from "../../html-text";
import { safely, ToolInputError, type IntelToolContext } from "./context";

export type ItemKind = "hint" | "opdracht" | "nieuws";

const KIND_TYPES: Record<ItemKind, string> = { hint: "hint", opdracht: "assignment", nieuws: "news" };

export function itemKind(type: string): ItemKind {
  return type === "hint" ? "hint" : type === "assignment" ? "opdracht" : "nieuws";
}

export interface HintCellView {
  area: string;
  status: "open" | "solved" | "none";
  slotTime: string;
  answer: string | null;
  location: { lat: number; lng: number } | null;
  /** The part of the hint for this area (plain text), when the split found one */
  snippet: string | null;
}

export interface ItemView {
  articleId: number;
  title: string;
  kind: ItemKind;
  publishAt: string;
  endTime: string | null;
  maxPoints: number | null;
  summary: string | null;
  text: string;
  images: { name: string; url: string }[];
  attachments: string[];
  hintCells: HintCellView[];
}

const MAX_ITEM_TEXT = 12_000;
const MAX_SNIPPET = 1500;

interface ArticleLike {
  id: number;
  title: string;
  type: string;
  publishAt: Date;
  content: string;
  endTime?: Date | null;
  maxPoints?: number | null;
  summary?: string | null;
}

interface CellLike {
  area: string;
  status: string;
  slotTime: Date;
  answer?: string | null;
  answerLocation?: number[] | null;
  snippet?: string | null;
}

export function cellView(cell: CellLike): HintCellView {
  const status = cell.status === HintCellStatus.Solved ? "solved" : cell.status === HintCellStatus.None ? "none" : "open";
  const location = cell.answerLocation?.length === 2 ? { lng: cell.answerLocation[0], lat: cell.answerLocation[1] } : null;
  return {
    area: cell.area,
    status,
    slotTime: cell.slotTime.toISOString(),
    answer: status === "solved" ? (cell.answer ?? null) : null,
    location: status === "solved" ? location : null,
    snippet: cell.snippet ? htmlToText(cell.snippet).slice(0, MAX_SNIPPET) : null,
  };
}

export function itemView(article: ArticleLike, cells: CellLike[]): ItemView {
  return {
    articleId: article.id,
    title: article.title,
    kind: itemKind(article.type),
    publishAt: article.publishAt.toISOString(),
    endTime: article.endTime ? article.endTime.toISOString() : null,
    maxPoints: article.maxPoints ?? null,
    summary: article.summary || null,
    text: htmlToText(article.content).slice(0, MAX_ITEM_TEXT),
    images: articleImages(article.content).map(({ name, url }) => ({ name, url })),
    attachments: articleAttachments(article.content),
    hintCells: [...cells].sort((a, b) => AREAS.indexOf(a.area as AreaName) - AREAS.indexOf(b.area as AreaName)).map(cellView),
  };
}

/** A public article (not a seeded test hint), or null */
export function findPublicArticle(articleId: number) {
  return Article.findOne({ $and: [{ id: articleId }, publicArticlesFilter()] }).lean();
}

/** The item as the chat sees it, or null when it is not a public article */
export async function loadItemView(articleId: number): Promise<ItemView | null> {
  const article = await findPublicArticle(articleId);
  if (!article) return null;
  const cells = article.type === "hint" ? await HintCell.find({ articleId }).lean() : [];
  return itemView(article, cells);
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Up to 10 public articles whose title or text contains the query, newest first, with a snippet around the match */
export async function searchIntel(query: string, kind?: ItemKind) {
  const q = query.trim();
  if (q.length < 2 || q.length > 100) throw new ToolInputError("Zoekterm moet 2 tot 100 tekens zijn");
  const pattern = new RegExp(escapeRegExp(q), "i");
  const articles = await Article.find(
    { $and: [publicArticlesFilter(), { $or: [{ title: pattern }, { content: pattern }] }, ...(kind ? [{ type: KIND_TYPES[kind] }] : [])] },
    { _id: 0, id: 1, title: 1, type: 1, publishAt: 1, content: 1 },
  )
    .sort({ publishAt: -1 })
    .limit(10)
    .lean();
  return {
    results: articles.map((article) => {
      const text = htmlToText(article.content);
      const at = text.toLowerCase().indexOf(q.toLowerCase());
      const snippet = at < 0 ? text.slice(0, 160) : `${at > 80 ? "…" : ""}${text.slice(Math.max(0, at - 80), at + q.length + 80)}${at + q.length + 80 < text.length ? "…" : ""}`;
      return { articleId: article.id, title: article.title, kind: itemKind(article.type), publishAt: article.publishAt.toISOString(), snippet };
    }),
  };
}

/** Hint cells of public hints (one area or all), newest slot first, at most 150 */
export async function hintBoard(area?: string) {
  const key = area === undefined ? null : knownAreaName(area);
  if (area !== undefined && !key) throw new ToolInputError(`Onbekend deelgebied: ${area}`);
  const cells = await HintCell.find({ articleId: publicArticlesFilter().id, ...(key ? { area: key } : {}) })
    .sort({ slotTime: -1 })
    .limit(150)
    .lean();
  const titles = new Map((await Article.find({ id: { $in: [...new Set(cells.map((cell) => cell.articleId))] } }, { _id: 0, id: 1, title: 1 }).lean()).map((article) => [article.id, article.title]));
  return {
    cells: cells.map((cell) => {
      const { area: cellArea, status, slotTime, answer, location } = cellView(cell);
      return { articleId: cell.articleId, articleTitle: titles.get(cell.articleId) ?? `Hint ${cell.articleId}`, area: cellArea, slotTime, status, answer, location };
    }),
  };
}

const STATUS_TEXT: Record<string, string> = { green: "actief", orange: "onderweg", red: "inactief" };

/** Our own (hoofd) fox team: the area of the home team (HOME_TEAM_API_ID) */
async function ownArea(): Promise<AreaName | null> {
  const { homeTeamApiId } = groupConfig();
  if (!homeTeamApiId) return null;
  const team = await Team.findOne({ apiId: homeTeamApiId }, { _id: 0, area: 1 }).lean();
  return knownAreaName(team?.area);
}

/**
 * Every fox team with its status and whether we may hunt it (rule 5.1, same rule as the site's Vossen card: our own
 * area always; others when the admin allowed them; everything while not configured). `huntableNow` also needs
 * status green or orange.
 */
export async function areasOverview() {
  const [areas, own] = await Promise.all([Area.find({}, { _id: 0, name: 1, status: 1, updatedAt: 1 }).lean(), ownArea()]);
  const allowedList = getHuntableAreas();
  const byName = new Map(areas.map((area) => [knownAreaName(area.name), area]));
  return {
    ownArea: own,
    huntableConfigured: allowedList !== null,
    areas: AREAS.map((area) => {
      const doc = byName.get(area);
      const status = doc?.status ?? "unknown";
      const allowed = !allowedList || area === own || allowedList.includes(area);
      return {
        area,
        status,
        statusText: STATUS_TEXT[status] ?? "onbekend",
        own: area === own,
        allowed,
        huntableNow: allowed && (status === "green" || status === "orange"),
        updatedAt: doc?.updatedAt ? doc.updatedAt.toISOString() : null,
      };
    }),
  };
}

const KIND_VALUES: ItemKind[] = ["hint", "opdracht", "nieuws"];

export function appDataTools(ctx: IntelToolContext) {
  return {
    getItem: tool({
      description: "Lees een Intel-item: titel, soort, tekst, samenvatting, afbeeldingen, bijlagen en (bij een hint) de hintvakken per deelgebied met status en antwoord. Zonder articleId: het open item.",
      inputSchema: jsonSchema<{ articleId?: number }>({ type: "object", properties: { articleId: { type: "integer", description: "Id van een ander item; weglaten voor het open item" } } }),
      execute: ({ articleId }) =>
        safely("getItem", async () => {
          const item = await loadItemView(articleId ?? ctx.articleId);
          if (!item) throw new ToolInputError(`Item ${articleId ?? ctx.articleId} niet gevonden`);
          return item;
        }),
    }),
    searchIntel: tool({
      description: "Zoek in alle Intel-items (hints, opdrachten, nieuws) op een woord of zin in titel of tekst. Geeft de 10 nieuwste treffers met een stukje tekst.",
      inputSchema: jsonSchema<{ query: string; kind?: ItemKind }>({
        type: "object",
        properties: { query: { type: "string", description: "Zoekterm (2-100 tekens)" }, kind: { type: "string", enum: KIND_VALUES, description: "Alleen dit soort item" } },
        required: ["query"],
      }),
      execute: ({ query, kind }) => safely("searchIntel", () => searchIntel(query, kind)),
    }),
    getHintBoard: tool({
      description: "Het hintbord: per hint en deelgebied de status (open, solved, none = geen hint), het opgeslagen antwoord en de locatie daarvan. Optioneel één deelgebied.",
      inputSchema: jsonSchema<{ area?: string }>({ type: "object", properties: { area: { type: "string", enum: [...AREAS], description: "Alleen dit deelgebied" } } }),
      execute: ({ area }) => safely("getHintBoard", () => hintBoard(area)),
    }),
    getAreas: tool({
      description: "Alle vossenteams (deelgebieden) met status (green = actief, orange = onderweg, red = inactief), ons eigen vossenteam en of we ze mogen hunten.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
      execute: () => safely("getAreas", () => areasOverview()),
    }),
  };
}
