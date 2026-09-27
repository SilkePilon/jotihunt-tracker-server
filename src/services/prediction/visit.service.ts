import { GroupVisit, VisitSource, VisitState } from "../../models/group-visit.model";
import { Prediction } from "../../models/prediction.model";
import { Team } from "../../models/team.model";
import type { AutoVisit, ManualVisit, VisitStateValue } from "./visits";

export type VisitInput = "visited" | "not_visited" | "auto";

export interface VisitDto {
  area: string;
  teamApiId: number;
  round: number;
  state: VisitStateValue;
  source: "auto" | "manual";
  visitedAt: Date | null;
}

interface VisitDoc {
  area: string;
  teamApiId: number;
  round: number;
  state: string;
  source: string;
  visitedAt?: Date | null;
}

function toDto(doc: VisitDoc): VisitDto {
  return {
    area: doc.area,
    teamApiId: doc.teamApiId,
    round: doc.round,
    state: doc.state as VisitStateValue,
    source: doc.source as "auto" | "manual",
    visitedAt: doc.visitedAt ?? null,
  };
}

async function currentRoundFor(area: string): Promise<number> {
  const prediction = await Prediction.findOne({ area }, { round: 1 }).lean();
  return prediction?.round ?? 1;
}

export async function loadManualVisits(area: string): Promise<ManualVisit[]> {
  const docs = await GroupVisit.find({ area, source: VisitSource.Manual }).sort({ teamApiId: 1, round: 1 }).lean();
  return docs.map((doc) => ({ teamApiId: doc.teamApiId, round: doc.round, state: doc.state as VisitStateValue, visitedAt: doc.visitedAt ?? null }));
}

/** Changes whenever a manual visit of the area is added, changed or removed. */
export async function manualVisitsVersion(area: string): Promise<string> {
  const [count, latest] = await Promise.all([
    GroupVisit.countDocuments({ area, source: VisitSource.Manual }),
    GroupVisit.findOne({ area, source: VisitSource.Manual }).sort({ updatedAt: -1 }).lean(),
  ]);
  return `${count}:${latest?.updatedAt?.toISOString() ?? ""}`;
}

/** Replace all auto visits of an area with a freshly computed set. Manual visits are left alone. */
export async function replaceAutoVisits(area: string, visits: AutoVisit[]): Promise<void> {
  await GroupVisit.deleteMany({ area, source: VisitSource.Auto });
  if (visits.length === 0) return;
  await GroupVisit.insertMany(
    visits.map((visit) => ({
      area,
      teamApiId: visit.teamApiId,
      round: visit.round,
      state: VisitState.Visited,
      source: VisitSource.Auto,
      visitedAt: visit.visitedAt,
      evidence: visit.evidence,
    })),
  );
}

/**
 * Set or clear a manual override for a group. `visited` / `not_visited` apply to the area's
 * current round; `auto` removes the team's newest manual override.
 * @returns null when the team is unknown or has no area
 */
export async function setManualVisit(teamApiId: number, state: VisitInput, now = new Date()): Promise<{ area: string; visit: VisitDto } | null> {
  const team = await Team.findOne({ apiId: teamApiId }).lean();
  if (!team?.area) return null;
  const area = team.area.toLowerCase();
  const round = await currentRoundFor(area);

  if (state === "auto") {
    const override = await GroupVisit.findOne({ teamApiId, source: VisitSource.Manual }).sort({ round: -1 });
    if (override) await override.deleteOne();
    const remaining = await GroupVisit.findOne({ teamApiId, round }).lean();
    return { area, visit: remaining ? toDto(remaining) : { area, teamApiId, round, state: "not_visited", source: "auto", visitedAt: null } };
  }

  const doc = await GroupVisit.findOneAndUpdate(
    { teamApiId, round },
    { $set: { area, state, source: VisitSource.Manual, visitedAt: state === "visited" ? now : null, evidence: "manual" } },
    { upsert: true, returnDocument: "after" },
  ).lean();
  return { area, visit: toDto(doc as VisitDoc) };
}

/** Visits of every area's current round (round 1 for areas without a stored prediction). */
export async function listCurrentVisits(): Promise<VisitDto[]> {
  const [predictions, docs] = await Promise.all([Prediction.find({}, { area: 1, round: 1 }).lean(), GroupVisit.find().sort({ teamApiId: 1 }).lean()]);
  const roundByArea = new Map(predictions.map((prediction) => [prediction.area, prediction.round ?? 1]));
  return docs.filter((doc) => doc.round === (roundByArea.get(doc.area) ?? 1)).map(toDto);
}
