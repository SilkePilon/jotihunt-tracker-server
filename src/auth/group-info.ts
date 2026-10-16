import { Team } from "../models/team.model";
import { general } from "../settings/app-config";
import { groupConfig } from "./config";

/** The own group for the invite page: the configured name and logo first, else the home team's, else the app name. */
export async function groupInfo(): Promise<{ name: string; logoUrl: string | null }> {
  const { homeTeamApiId, groupName } = groupConfig();
  const logo = general("logoUrl");
  const team = homeTeamApiId ? await Team.findOne({ apiId: homeTeamApiId }, { name: 1, logoUrl: 1 }).lean() : null;
  return { name: groupName ?? team?.name ?? "Jotihunt Tracker", logoUrl: logo.source !== "default" ? logo.value : (team?.logoUrl ?? null) };
}
