import { GroupVisit, VisitSource, VisitState } from "../../models/group-visit.model";
import { Prediction } from "../../models/prediction.model";
import { Team } from "../../models/team.model";

export type VisitInput = "visited" | "not_visited" | "auto";

export interface VisitDto {
  area: string;
  teamApiId: number;
  round: number;
  state: "visited" | "not_visited";
  /** auto = decided by the AI prediction */
  source: "auto" | "manual";
  visitedAt: Date | null;
}

async function currentRoundFor(area: string): Promise<number> {
  return (await Prediction.findOne({ area }, { round: 1 }).lean())?.round ?? 1;
}

/**
 * Set or clear a manual override for a group in the area's current round.
 * @returns null when the team is unknown or has no area
 */
export async function setManualVisit(teamApiId: number, state: VisitInput, now = new Date()): Promise<{ area: string; visit: VisitDto } | null> {
  const team = await Team.findOne({ apiId: teamApiId }).lean();
  if (!team?.area) return null;
  const area = team.area.toLowerCase();
  const round = await currentRoundFor(area);

  if (state === "auto") {
    await GroupVisit.deleteOne({ teamApiId, round, source: VisitSource.Manual });
    const prediction = await Prediction.findOne({ area }, { visitedTeamApiIds: 1 }).lean();
    const visited = (prediction?.visitedTeamApiIds ?? []).includes(teamApiId);
    return { area, visit: { area, teamApiId, round, state: visited ? "visited" : "not_visited", source: "auto", visitedAt: null } };
  }

  const doc = await GroupVisit.findOneAndUpdate(
    { teamApiId, round },
    { $set: { area, state, source: VisitSource.Manual, visitedAt: state === VisitState.Visited ? now : null, evidence: "manual" } },
    { upsert: true, returnDocument: "after" },
  ).lean();
  return { area, visit: { area, teamApiId, round, state, source: "manual", visitedAt: doc?.visitedAt ?? null } };
}

/** Current-round visits: manual overrides plus the groups the AI marked as visited. */
export async function listCurrentVisits(): Promise<VisitDto[]> {
  const [predictions, manual] = await Promise.all([
    Prediction.find({}, { area: 1, round: 1, visitedTeamApiIds: 1 }).lean(),
    GroupVisit.find({ source: VisitSource.Manual }).sort({ teamApiId: 1 }).lean(),
  ]);
  const roundByArea = new Map(predictions.map((prediction) => [prediction.area, prediction.round ?? 1]));
  const visits: VisitDto[] = manual
    .filter((doc) => doc.round === (roundByArea.get(doc.area) ?? 1))
    .map((doc) => ({ area: doc.area, teamApiId: doc.teamApiId, round: doc.round, state: doc.state as VisitDto["state"], source: "manual", visitedAt: doc.visitedAt ?? null }));
  const overridden = new Set(visits.map((visit) => visit.teamApiId));
  for (const prediction of predictions) {
    for (const teamApiId of prediction.visitedTeamApiIds ?? []) {
      if (!overridden.has(teamApiId)) visits.push({ area: prediction.area, teamApiId, round: prediction.round ?? 1, state: "visited", source: "auto", visitedAt: null });
    }
  }
  return visits.sort((a, b) => a.teamApiId - b.teamApiId);
}
