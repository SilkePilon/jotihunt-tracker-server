import { isObjectIdString } from "../utils/mongo";
import { authChallenges, type ChallengeKind } from "./models";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export async function saveChallenge(kind: ChallengeKind, challenge: string, payload: Record<string, unknown> = {}, now = new Date()): Promise<string> {
  const doc = await authChallenges().create({ kind, challenge, payload, expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS) });
  return String(doc._id);
}

/** Take (and delete) a live challenge of this kind; null when unknown, expired, already used or of another kind. */
export async function takeChallenge(id: string, kind: ChallengeKind, now = new Date()) {
  if (!isObjectIdString(id)) return null;
  const doc = await authChallenges().findOneAndDelete({ _id: id, kind, expiresAt: { $gt: now } }).lean();
  return doc ? { challenge: doc.challenge, payload: (doc.payload ?? {}) as Record<string, unknown> } : null;
}
