import { Team } from "../models/team.model";
import { groupConfig } from "./config";

/** The own group for the invite page: home team name + logo, else GROUP_NAME, else the app name. */
export async function groupInfo(): Promise<{ name: string; logoUrl: string | null }> {
  const { homeTeamApiId, groupName } = groupConfig();
  const team = homeTeamApiId ? await Team.findOne({ apiId: homeTeamApiId }, { name: 1, logoUrl: 1 }).lean() : null;
  return { name: team?.name ?? groupName ?? "Jotihunt Tracker", logoUrl: team?.logoUrl ?? null };
}
