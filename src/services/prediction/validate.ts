import { MAX_ETA_MINUTES, MAX_PIN_DISTANCE_M, MAX_WHY_LENGTH, TOP_CANDIDATES } from "./constants";
import type { AreaFacts } from "./facts";
import { distanceM } from "./geo";

export type Confidence = "low" | "medium" | "high";

export interface ValidPrediction {
  round: number;
  visitedTeamApiIds: number[];
  pin: { lat: number; lng: number };
  confidence: Confidence;
  candidates: { teamApiId: number; probability: number; etaMinutes: number }[];
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

  const manualVisited = facts.manualVisits.filter((visit) => visit.state === "visited").map((visit) => visit.teamApiId);
  const manualNot = new Set(facts.manualVisits.filter((visit) => visit.state === "not_visited").map((visit) => visit.teamApiId));
  const aiVisited = Array.isArray(raw.visitedTeamApiIds) ? raw.visitedTeamApiIds.filter(finite) : [];
  const visited = [...new Set([...aiVisited, ...manualVisited])].filter((id) => known.has(id) && !manualNot.has(id)).sort((a, b) => a - b);
  const visitedSet = new Set(visited);

  const seen = new Set<number>();
  const picked = (Array.isArray(raw.candidates) ? raw.candidates : [])
    .filter(isRecord)
    .filter((candidate) => finite(candidate.teamApiId) && known.has(candidate.teamApiId) && !visitedSet.has(candidate.teamApiId))
    .filter((candidate) => !seen.has(candidate.teamApiId as number) && seen.add(candidate.teamApiId as number))
    .map((candidate) => ({
      teamApiId: candidate.teamApiId as number,
      probability: finite(candidate.probability) ? Math.max(0, candidate.probability) : 0,
      etaMinutes: Math.min(MAX_ETA_MINUTES, Math.max(0, Math.round(finite(candidate.etaMinutes) ? candidate.etaMinutes : 0))),
    }))
    .sort((a, b) => b.probability - a.probability)
    .slice(0, TOP_CANDIDATES);
  const openGroups = facts.groups.length - visited.length;
  if (picked.length === 0 && openGroups > 0) throw new InvalidPredictionError("Geen geldige kandidaten");
  const total = picked.reduce((sum, candidate) => sum + candidate.probability, 0);
  const candidates = picked.map((candidate) => ({ ...candidate, probability: total > 0 ? candidate.probability / total : 1 / picked.length }));

  const pin = raw.pin;
  if (!isRecord(pin) || !finite(pin.lat) || !finite(pin.lng)) throw new InvalidPredictionError("Geen geldige pin");
  const last = facts.trail.at(-1);
  if (last && distanceM([last.lng, last.lat], [pin.lng, pin.lat]) > MAX_PIN_DISTANCE_M) throw new InvalidPredictionError("Pin te ver van laatste locatie");

  const round = finite(raw.round) ? Math.min(facts.round + 1, Math.max(facts.round, Math.round(raw.round))) : facts.round;
  const confidence: Confidence = raw.confidence === "high" || raw.confidence === "medium" ? raw.confidence : "low";
  const why = (typeof raw.reason === "string" ? raw.reason.trim() : "").slice(0, MAX_WHY_LENGTH);

  return { round, visitedTeamApiIds: visited, pin: { lat: pin.lat, lng: pin.lng }, confidence, candidates, why };
}
