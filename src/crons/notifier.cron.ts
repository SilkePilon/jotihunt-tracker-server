import { logger } from "../logger";
import { currentGeneration, runTracked } from "../demo/demo-mode";
import { runNotifier } from "../services/notifier.service";

/** Detect fox status changes, new articles and nearing hunt deadlines; runs on the active database (demo too). */
export default async function notify() {
  const generation = currentGeneration();
  try {
    const created = await runTracked(() => runNotifier({ log: logger }), { generation });
    if (created?.length) logger.info(`(CRON) Created ${created.length} notification(s): ${created.map((notification) => notification.title).join(" | ")}`);
  } catch (error) {
    logger.error("(CRON) Notifier failed", error);
  }
}
