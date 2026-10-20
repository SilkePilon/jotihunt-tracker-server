import { logger } from "../logger";
import { currentGeneration, runTracked, skipWhenArchive } from "../editions/work-tracking";
import { Area } from "../models/area.model";
import { AreaStatusEvent } from "../models/area-status-event.model";
import { AREA_STATUSES, AREA_TITLES, AREAS, areaTitle, knownAreaName } from "../constants/areas";
import { getAreas, JotihuntPausedError } from "../services/jotihunt.service";
import { ApiArea } from "../types/api";

export interface AreaUpdate {
  name: string;
  status: string;
  /** Missing when the API sent no valid time; the stored one is kept */
  updatedAt?: Date;
}

/**
 * The usable areas of one /areas answer: only known area names (stored as "Alpha" … "Oscar") with a known status.
 * Returns null when the whole answer looks broken (no usable area, or far more entries than there are areas):
 * then nothing is stored. Unknown names in an otherwise good answer are dropped; known areas with an unknown status
 * are dropped too and listed in `unknownStatuses`.
 */
export function parseAreasAnswer(apiAreas: ApiArea[]): { areas: AreaUpdate[]; ignored: number; unknownStatuses: { area: string; status: string }[] } | null {
  if (apiAreas.length > AREAS.length * 2) return null;
  const byName = new Map<string, AreaUpdate>();
  const unknownStatuses: { area: string; status: string }[] = [];
  for (const apiArea of apiAreas) {
    const area = knownAreaName(apiArea?.name);
    if (!area) continue;
    if (!(AREA_STATUSES as readonly string[]).includes(apiArea.status)) {
      unknownStatuses.push({ area: areaTitle(area), status: String(apiArea.status).slice(0, 40) });
      continue;
    }
    const updatedAt = new Date(apiArea.updated_at);
    byName.set(area, { name: areaTitle(area), status: apiArea.status, ...(Number.isNaN(updatedAt.getTime()) ? {} : { updatedAt }) });
  }
  if (byName.size === 0) return null;
  return { areas: [...byName.values()], ignored: apiAreas.length - byName.size, unknownStatuses };
}

/**
 * Upsert the areas of one answer. Areas missing from the answer are kept (a partial answer is a hiccup, not areas
 * disappearing); only names that are not a known area (left behind by a broken answer) are removed.
 */
export async function storeAreas(areas: AreaUpdate[]) {
  const previous = new Map((await Area.find({ name: { $in: areas.map((a) => a.name) } }).select("name status").lean()).map((a) => [a.name, a.status]));
  const changes = areas
    .filter((area) => previous.get(area.name) !== area.status)
    .map((area) => ({ area: area.name, status: area.status, at: area.updatedAt ?? new Date() }));
  if (changes.length) await AreaStatusEvent.insertMany(changes);
  await Area.bulkWrite(
    areas.map(({ updatedAt, ...area }) => ({
      updateOne: {
        filter: { name: area.name },
        update: updatedAt ? { $set: { ...area, updatedAt } } : { $set: area, $setOnInsert: { updatedAt: new Date() } },
        upsert: true,
      },
    })),
  );
  await Area.deleteMany({ name: { $nin: AREA_TITLES } });
}

/** Unknown statuses already warned about ("Oscar:purple"), so a new status logs once instead of every run. */
const warnedStatuses = new Set<string>();

export default async function retrieveJotihuntAreas() {
  if (skipWhenArchive("jotihunt-areas", (message) => logger.debug(message))) return;

  logger.debug("(CRON) Retrieving Jotihunt areas from API...");
  const generation = currentGeneration();

  let apiAreas: ApiArea[];
  try {
    apiAreas = await getAreas();
  } catch (error) {
    // Logged by the service (one line); a pause after errors/429 is expected and quiet
    if (error instanceof JotihuntPausedError) logger.debug(`(CRON) Areas skipped: ${error.message}`);
    return;
  }

  const parsed = parseAreasAnswer(apiAreas);
  if (!parsed) {
    logger.warn(`(CRON) Ignored an /areas answer without usable areas (${apiAreas.length} entries)`);
    return;
  }
  for (const { area, status } of parsed.unknownStatuses) {
    const key = `${area}:${status}`;
    if (warnedStatuses.has(key)) continue;
    warnedStatuses.add(key);
    logger.warn(`(CRON) Unknown status "${status}" for ${area} in the /areas answer; not stored`);
  }
  const otherIgnored = parsed.ignored - parsed.unknownStatuses.length;
  if (otherIgnored > 0) logger.warn(`(CRON) Ignored ${otherIgnored} unknown or invalid entries in the /areas answer`);
  logger.debug(`(CRON) Found ${parsed.areas.length} areas`);

  // Store only into the database the run started on (skipped when an edition switch happened meanwhile)
  await runTracked(
    () =>
      storeAreas(parsed.areas).catch((error) => {
        logger.error("(CRON) Error storing areas in database:", error);
      }),
    { generation },
  );
}
