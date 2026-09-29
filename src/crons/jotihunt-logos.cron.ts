import axios from "axios";
import { logger } from "..";
import { Team } from "../models/team.model";
import { USER_AGENT } from "../services/prediction/constants";
import { normalizeTeamName, parseTeamLogos } from "../services/team-logos.helpers";

/**
 * Copy the group logos shown on the public jotihunt.nl/subscriptions page to the teams (matched by name).
 * The API has no logo field; the page is public, so no login is needed.
 */
export default async function retrieveJotihuntLogos() {
  const baseUrl = (process.env.JOTIHUNT_WEB_URL || "https://jotihunt.nl").replace(/\/+$/, "");
  try {
    const { data } = await axios.get<string>(`${baseUrl}/subscriptions`, { timeout: 15_000, responseType: "text", headers: { "User-Agent": USER_AGENT } });
    const logos = parseTeamLogos(data);
    const teams = await Team.find({}, { name: 1, logoUrl: 1 });
    let updated = 0;
    for (const team of teams) {
      const logoUrl = logos.get(normalizeTeamName(team.name));
      if (logoUrl && logoUrl !== team.logoUrl) {
        await Team.updateOne({ _id: team._id }, { $set: { logoUrl } });
        updated++;
      }
    }
    logger.info(`(CRON) Group logos: ${logos.size} on jotihunt.nl, ${updated} teams updated`);
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    logger.warn(`(CRON) Could not retrieve group logos from jotihunt.nl${status ? ` (HTTP ${status})` : ""}`);
  }
}
