import { CLUSTER_RADIUS_M, HEADING_MAX_GAP_MIN, HEADING_MIN_DISTANCE_M, SOFTMAX_TEMPERATURE } from "./constants";
import { angleDiffDeg, bearingDeg, distanceM } from "./geo";
import type { LngLat, Observation, TermValues, Weights } from "./types";

export interface ScoringCandidate {
  teamApiId: number;
  location: LngLat;
  /** Effective travel time (walking / speedFactor, or transit) */
  travelMinutes: number;
}

export interface ScoringInput {
  position: LngLat;
  heading: number | null;
  candidates: ScoringCandidate[];
  /** Index (into candidates) of the first stop of the shortest tour, or null */
  tourFirstIndex: number | null;
  weights: Weights;
}

export interface ScoredCandidate {
  teamApiId: number;
  terms: TermValues;
  score: number;
  probability: number;
}

/**
 * Heading of the fox team: bearing between the last two observations, if they are
 * at least 200 m and at most 3 h apart.
 * @param observations Observations sorted by time ascending
 */
export function computeHeading(observations: Observation[]): number | null {
  if (observations.length < 2) return null;
  const [previous, last] = observations.slice(-2);
  const gapMinutes = (last.time.getTime() - previous.time.getTime()) / 60_000;
  const from: LngLat = [previous.lng, previous.lat];
  const to: LngLat = [last.lng, last.lat];
  if (gapMinutes > HEADING_MAX_GAP_MIN || distanceM(from, to) < HEADING_MIN_DISTANCE_M) return null;
  return bearingDeg(from, to);
}

/** The four normalised (0–1) score terms per candidate. */
export function computeTerms(input: ScoringInput): TermValues[] {
  const { position, heading, candidates, tourFirstIndex } = input;
  const maxTravel = Math.max(0, ...candidates.map((candidate) => candidate.travelMinutes));
  return candidates.map((candidate, index) => {
    const time = maxTravel > 0 ? 1 - candidate.travelMinutes / maxTravel : 1;
    const headingTerm =
      heading === null ? 0 : Math.max(0, Math.cos((angleDiffDeg(heading, bearingDeg(position, candidate.location)) * Math.PI) / 180));
    const tour = tourFirstIndex === index ? 1 : 0;
    const neighbours = candidates.filter(
      (other, otherIndex) => otherIndex !== index && distanceM(other.location, candidate.location) <= CLUSTER_RADIUS_M,
    ).length;
    return { time, heading: headingTerm, tour, cluster: neighbours / candidates.length };
  });
}

export function weightedScore(terms: TermValues, weights: Weights): number {
  return weights.wTime * terms.time + weights.wHeading * terms.heading + weights.wTour * terms.tour + weights.wCluster * terms.cluster;
}

/** Softmax of score / temperature (max-subtracted for stability). */
export function softmax(scores: number[], temperature = SOFTMAX_TEMPERATURE): number[] {
  if (scores.length === 0) return [];
  const scaled = scores.map((score) => score / temperature);
  const max = Math.max(...scaled);
  const exps = scaled.map((value) => Math.exp(value - max));
  const sum = exps.reduce((total, value) => total + value, 0);
  return exps.map((value) => value / sum);
}

/** Score every candidate; the result has the same order as input.candidates. */
export function scoreCandidates(input: ScoringInput): ScoredCandidate[] {
  const terms = computeTerms(input);
  const scores = terms.map((candidateTerms) => weightedScore(candidateTerms, input.weights));
  const probabilities = softmax(scores);
  return input.candidates.map((candidate, index) => ({
    teamApiId: candidate.teamApiId,
    terms: terms[index],
    score: scores[index],
    probability: probabilities[index],
  }));
}
