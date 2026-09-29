import { MAX_PIN_DISTANCE_M, MAX_WHY_LENGTH } from "./constants";
import type { AreaFacts } from "./facts";
import { distanceM } from "./geo";

export type Confidence = "low" | "medium" | "high";

export interface ValidPrediction {
  round: number;
  visitedTeamApiIds: number[];
  pin: { lat: number; lng: number };
  confidence: Confidence;
  why: string;
}

export class InvalidPredictionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPredictionError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Turn Gemini's raw JSON into a safe prediction, or throw InvalidPredictionError. */
export function validatePrediction(raw: unknown, facts: AreaFacts): ValidPrediction {
  if (!isRecord(raw)) throw new InvalidPredictionError("Antwoord is geen object");
  const known = new Set(facts.groups.map((group) => group.teamApiId));

  const aiVisited = Array.isArray(raw.visitedTeamApiIds) ? raw.visitedTeamApiIds.filter(finite) : [];
  const currentManualVisited = facts.manualVisits.filter((visit) => visit.state === "visited").map((visit) => visit.teamApiId);
  const currentManualNot = new Set(facts.manualVisits.filter((visit) => visit.state === "not_visited").map((visit) => visit.teamApiId));
  // Gemini may only start the next round once (almost) every group is covered
  const covered = new Set([...facts.previousVisited, ...aiVisited, ...currentManualVisited].filter((id) => known.has(id) && !currentManualNot.has(id)));
  const mayAdvance = known.size > 0 && covered.size >= known.size - 1;
  const rawRound = finite(raw.round) ? Math.round(raw.round) : facts.round;
  const round = rawRound === facts.round + 1 && mayAdvance ? facts.round + 1 : facts.round;
  const manualVisited = round === facts.round ? currentManualVisited : [];
  const manualNot = round === facts.round ? currentManualNot : new Set<number>();
  const visited = [...new Set([...aiVisited, ...manualVisited])].filter((id) => known.has(id) && !manualNot.has(id)).sort((a, b) => a - b);

  const pin = raw.pin;
  if (!isRecord(pin) || !finite(pin.lat) || !finite(pin.lng)) throw new InvalidPredictionError("Geen geldige pin");
  const last = facts.trail.at(-1);
  if (last && distanceM([last.lng, last.lat], [pin.lng, pin.lat]) > MAX_PIN_DISTANCE_M) throw new InvalidPredictionError("Pin te ver van laatste locatie");

  const confidence: Confidence = raw.confidence === "high" || raw.confidence === "medium" ? raw.confidence : "low";
  const why = (typeof raw.reason === "string" ? raw.reason.trim() : "").slice(0, MAX_WHY_LENGTH);

  return { round, visitedTeamApiIds: visited, pin: { lat: pin.lat, lng: pin.lng }, confidence, why };
}
