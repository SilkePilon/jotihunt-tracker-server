import { logger } from "../logger";
import { currentGeneration, runTracked, skipInDemoMode } from "../demo/demo-mode";
import { Area } from "../models/area.model";
import { getAreas } from "../services/jotihunt.service";

export default async function retrieveJotihuntAreas() {
  if (skipInDemoMode("jotihunt-areas", (message) => logger.debug(message))) return;

  logger.debug("(CRON) Retrieving Jotihunt areas from API...");
  const generation = currentGeneration();

  const apiAreas = await getAreas();

  const areas = apiAreas.map((team) => {
    return {
      name: team.name,
      status: team.status,
      updatedAt: new Date(team.updated_at),
    };
  });

  logger.debug(`(CRON) Found ${areas.length} areas`);
  // An empty answer is an API hiccup, not nine areas disappearing
  if (areas.length === 0) return;

  // Store only into the database the run started on (skipped when a demo switch happened meanwhile)
  await runTracked(
    async () => {
      // Upsert by name and drop the rest: readers never see an empty or half-filled collection
      await Area.bulkWrite(areas.map((area) => ({ updateOne: { filter: { name: area.name }, update: { $set: area }, upsert: true } })))
        .then(() => Area.deleteMany({ name: { $nin: areas.map((area) => area.name) } }))
        .catch((error) => {
          logger.error("(CRON) Error storing areas in database:", error);
        });
    },
    { generation },
  );
}
