import { Area } from "../models/area.model";
import { Article, publicArticlesFilter } from "../models/article.model";
import { HuntReport } from "../models/hunt-report.model";
import { AppNotification, type AppNotificationDocument } from "../models/notification.model";
import { NotifierState } from "../models/notifier-state.model";
import {
  buildArticleNotification,
  buildDeadlineNotification,
  buildFoxStatusNotification,
  diffAreaStatus,
  dueDeadlineWarnings,
  HUNT_SUBMIT_WINDOW_MS,
  type NotificationInput,
} from "./notifier.helpers";
import { currentGeneration, runTracked } from "../demo/demo-mode";
import { deadline } from "./http-limits";
import { sendToAll } from "./push.service";
import { isDuplicateKeyError } from "../utils/mongo";

const STATE_KEY = "notifier";
const MAX_ARTICLES_PER_RUN = 3;

interface NotifierOptions {
  now?: Date;
  send?: (notification: AppNotificationDocument) => Promise<unknown>;
  log?: { error(message: string, error?: unknown): void };
  /** tests only */
  pushTrackLimitMs?: number;
}

/** A push still running after this stops counting for a database switch (which waits at most 10 s). */
const PUSH_TRACK_LIMIT_MS = 8_000;

/**
 * Compare the database with what was seen last and store a notification per change (fox status, new article,
 * hunt 10 minutes before its submit deadline), then push them. The first run per database only records the
 * current state, so a restart or demo switch doesn't flood everyone. The new state is claimed with a
 * compare-and-set before anything is announced, so overlapping runs (cron overlap, a second process) never announce
 * the same change twice; when storing the notifications fails the state is rolled back so the next run re-detects.
 * @returns The created notifications
 */
export async function runNotifier(options: NotifierOptions = {}): Promise<AppNotificationDocument[]> {
  const now = options.now ?? new Date();
  const send = options.send ?? ((notification) => sendToAll(notification));
  const log = options.log ?? console;

  const [state, areas] = await Promise.all([NotifierState.findOne({ key: STATE_KEY }).lean(), Area.find({}, { name: 1, status: 1 }).lean()]);
  const currentStatus = Object.fromEntries(areas.map((area) => [area.name, area.status]));

  if (!state?.initialized) {
    const latest = await Article.findOne(publicArticlesFilter(), { id: 1 }).sort({ id: -1 }).lean();
    try {
      // Only one of overlapping first runs stores the state
      await NotifierState.updateOne(
        { key: STATE_KEY, initialized: { $ne: true } },
        { $set: { areaStatus: currentStatus, lastArticleId: latest?.id ?? 0, initialized: true, version: (state?.version ?? 0) + 1 } },
        { upsert: true },
      );
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
    }
    return [];
  }

  const previousStatus: Record<string, string> = { ...(state.areaStatus as Record<string, string> | undefined) };
  const statusChanges = diffAreaStatus(previousStatus, areas);

  const articles = await Article.find(
    { $and: [publicArticlesFilter(), { id: { $gt: state.lastArticleId } }] },
    { id: 1, title: 1, type: 1, endTime: 1 },
  )
    .sort({ id: 1 })
    .lean();

  // Claim the transition: only the run that moves the state from what it read announces these changes.
  // Merge: areas missing from a partial read keep their last known status.
  const claimedVersion = (state.version ?? 0) + 1;
  const claim = await NotifierState.updateOne(
    { key: STATE_KEY, version: state.version ?? null },
    {
      $set: {
        areaStatus: { ...previousStatus, ...currentStatus },
        lastArticleId: articles.length > 0 ? articles[articles.length - 1].id : state.lastArticleId,
        version: claimedVersion,
      },
    },
  );
  const ownsTransition = claim.matchedCount === 1;

  const inputs: NotificationInput[] = [];
  if (ownsTransition) {
    inputs.push(...statusChanges.map(buildFoxStatusNotification));
    // After a demo stint a backlog can pile up: announce only the newest few (lastArticleId still advances past all)
    inputs.push(...articles.slice(-MAX_ARTICLES_PER_RUN).map(buildArticleNotification));
  }

  // Hunt time can lie before the upload, so look back a bit further than the submit window
  const open = await HuntReport.find(
    { submittedAt: null, deadlineWarnedAt: null, site: null, createdAt: { $gte: new Date(now.getTime() - 3 * HUNT_SUBMIT_WINDOW_MS) } },
    { area: 1, huntTime: 1, takenAt: 1, createdAt: 1, reportedByName: 1, submittedAt: 1, deadlineWarnedAt: 1, site: 1, photo: 1 },
  ).lean();
  const claimedIds: unknown[] = [];
  for (const report of dueDeadlineWarnings(open, now)) {
    // Conditional claim: two overlapping runs never both warn
    const claim = await HuntReport.updateOne({ _id: report._id, deadlineWarnedAt: null }, { $set: { deadlineWarnedAt: now } });
    if (claim.modifiedCount === 1) {
      claimedIds.push(report._id);
      inputs.push(buildDeadlineNotification(report, now));
    }
  }

  let created: AppNotificationDocument[] = [];
  try {
    if (inputs.length > 0) created = await AppNotification.insertMany(inputs.map((input) => ({ ...input, createdAt: new Date() })));
  } catch (error) {
    // Release the claims so the next run re-detects the warnings and changes instead of losing them
    if (claimedIds.length > 0) {
      await HuntReport.updateMany({ _id: { $in: claimedIds }, deadlineWarnedAt: now }, { $set: { deadlineWarnedAt: null } });
    }
    if (ownsTransition) {
      await NotifierState.updateOne(
        { key: STATE_KEY, version: claimedVersion },
        { $set: { areaStatus: previousStatus, lastArticleId: state.lastArticleId, version: claimedVersion + 1 } },
      );
    }
    throw error;
  }

  const generation = currentGeneration();
  for (const notification of created) {
    // Tracked, so a database switch waits for it and a push started before a switch never touches the other database
    // A hanging push endpoint stops counting after a while, so it can't block switching
    const limitMs = options.pushTrackLimitMs ?? PUSH_TRACK_LIMIT_MS;
    runTracked(() => deadline(Promise.resolve().then(() => send(notification)), limitMs, `Push still running after ${limitMs / 1000} s`), { generation })
      .catch((error) => log.error("Pushing a notification failed", error));
  }
  return created;
}
