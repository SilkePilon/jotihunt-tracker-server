import type { LanguageModel } from "ai";
import { logger } from "../../../logger";
import { GeminiError } from "../../ai/gemini-error";
import type { WalkMinutes } from "../../prediction/walking";

/** What every tool of one chat request may use */
export interface IntelToolContext {
  /** The item open in the Intel window */
  articleId: number;
  now: () => Date;
  /** Model for the webSearch, runCode and lookAtPoint sub-calls */
  toolModel: LanguageModel;
  /** Walking minutes via ORS (distance tool); a straight-line estimate without it */
  walkMinutes?: WalkMinutes;
  /** HTTP for PDOK, Overpass, OVapi, NS and readWebPage (tests pass a fake) */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** DNS lookup for readWebPage's address check (tests pass a fake) */
  lookup?: (hostname: string) => Promise<string[]>;
  /** NS Reisinformatie key; undefined = process.env.NS_API_KEY, "" = none (train data skipped) */
  nsApiKey?: string;
  /** Paid/limited sub-calls used this turn (createIntelTools starts a fresh one per turn) */
  budget?: TurnBudget;
}

/** Paid or rate-limited sub-calls per turn (one question) */
export const TURN_LIMITS = { webSearch: 6, runCode: 4, walkingRoute: 5, findPlaces: 4, lookAtPoint: 3, ov: 25 } as const;
export type TurnBudget = Record<keyof typeof TURN_LIMITS, number>;
export const BUDGET_EXHAUSTED = "Limiet voor deze vraag bereikt";

/** A budget for one turn: nothing used yet */
export const createTurnBudget = (): TurnBudget => ({ webSearch: 0, runCode: 0, walkingRoute: 0, findPlaces: 0, lookAtPoint: 0, ov: 0 });

/** Use one call of `kind`; false (nothing used) when this turn's limit is reached */
export function spend(budget: TurnBudget, kind: keyof typeof TURN_LIMITS): boolean {
  if (budget[kind] >= TURN_LIMITS[kind]) return false;
  budget[kind]++;
  return true;
}

/** A tool's failure as the model sees it */
export interface ToolError {
  error: string;
}

/** A failure whose (Dutch) message may go to the model as is: bad input, nothing found, upstream refused */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/**
 * Run a tool body; every failure becomes `{ error }` (never thrown into the stream). Only our own messages pass through;
 * anything unexpected is logged and reported as a generic error.
 */
export async function safely<T>(tool: string, run: () => Promise<T>): Promise<T | ToolError> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ToolInputError || error instanceof GeminiError) return { error: error.message };
    logger.warn(`Intel chat tool ${tool} failed: ${error instanceof Error ? error.name : "unknown error"}`);
    return { error: "Deze tool liep vast; probeer het anders" };
  }
}
