import { logger } from "..";
import { currentGeneration, runTracked, skipInDemoMode } from "../demo/demo-mode";
import { Area } from "../models/area.model";
import { getAreas } from "../services/jotihunt.service";

export default async function retrieveJotihuntAreas() {
  if (skipInDemoMode("jotihunt-areas", (message) => logger.debug(message))) return;

  logger.info("(CRON) Retrieving Jotihunt areas from API...");
  const generation = currentGeneration();

  const apiAreas = await getAreas();

  const areas = apiAreas.map((team) => {
    return {
      name: team.name,
      status: team.status,
      updatedAt: new Date(team.updated_at),
    };
  });

  logger.info(`(CRON) Found ${areas.length} areas`);

  // Store only into the database the run started on (skipped when a demo switch happened meanwhile)
  await runTracked(
    async () => {
      await Area.deleteMany({}).catch((error) => {
        logger.error("(CRON) Error deleting areas from database:", error);
      });
      await Area.insertMany(areas).catch((error) => {
        logger.error("(CRON) Error inserting areas into database:", error);
      });
    },
    { generation },
  );
}
