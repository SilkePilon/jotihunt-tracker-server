import axios from "axios";
import { logger } from "../logger";
import { currentGeneration, runTracked, skipInDemoMode } from "../demo/demo-mode";
import { Team } from "../models/team.model";
import { MB } from "../services/http-limits";
import { USER_AGENT } from "../services/prediction/constants";
import { normalizeTeamName, parseTeamLogos } from "../services/team-logos.helpers";

/**
 * Copy the group logos shown on the public jotihunt.nl/subscriptions page to the teams (matched by name).
 * The API has no logo field; the page is public, so no login is needed.
 */
export default async function retrieveJotihuntLogos() {
  if (skipInDemoMode("jotihunt-logos", (message) => logger.debug(message))) return;

  const baseUrl = (process.env.JOTIHUNT_WEB_URL || "https://jotihunt.nl").replace(/\/+$/, "");
  const generation = currentGeneration();
  try {
    const { data } = await axios.get<string>(`${baseUrl}/subscriptions`, {
      timeout: 15_000,
      // Total deadline: axios' timeout is idle-only under Bun
      signal: AbortSignal.timeout(15_000),
      maxContentLength: 5 * MB,
      responseType: "text",
      headers: { "User-Agent": USER_AGENT },
    });
    const logos = parseTeamLogos(data);
    // Store only into the database the run started on (skipped when a demo switch happened meanwhile)
    const updated = await runTracked(
      async () => {
        const teams = await Team.find({}, { name: 1, logoUrl: 1 });
        let count = 0;
        for (const team of teams) {
          const logoUrl = logos.get(normalizeTeamName(team.name));
          if (logoUrl && logoUrl !== team.logoUrl) {
            await Team.updateOne({ _id: team._id }, { $set: { logoUrl } });
            count++;
          }
        }
        return count;
      },
      { generation },
    );
    if (updated === undefined) return;
    logger.info(`(CRON) Group logos: ${logos.size} on jotihunt.nl, ${updated} teams updated`);
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    logger.warn(`(CRON) Could not retrieve group logos from jotihunt.nl${status ? ` (HTTP ${status})` : ""}`);
  }
}
