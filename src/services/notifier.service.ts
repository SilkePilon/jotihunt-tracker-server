import { Area } from "../models/area.model";
import { Article } from "../models/article.model";
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
import { sendToAll } from "./push.service";

const STATE_KEY = "notifier";

interface NotifierOptions {
  now?: Date;
  send?: (notification: AppNotificationDocument) => Promise<unknown>;
  log?: { error(message: string, error?: unknown): void };
}

/**
 * Compare the database with what was seen last and store a notification per change (fox status, new article,
 * hunt 10 minutes before its submit deadline), then push them. The first run per database only records the
 * current state, so a restart or demo switch doesn't flood everyone. State is saved after the notifications,
 * so a crash in between re-detects (a duplicate at worst) instead of losing an event.
 * @returns The created notifications
 */
export async function runNotifier(options: NotifierOptions = {}): Promise<AppNotificationDocument[]> {
  const now = options.now ?? new Date();
  const send = options.send ?? ((notification) => sendToAll(notification));
  const log = options.log ?? console;

  const state = (await NotifierState.findOne({ key: STATE_KEY })) ?? new NotifierState({ key: STATE_KEY });
  const areas = await Area.find({}, { name: 1, status: 1 }).lean();

  if (!state.initialized) {
    const latest = await Article.findOne({}, { id: 1 }).sort({ id: -1 }).lean();
    state.areaStatus = new Map(areas.map((area) => [area.name, area.status]));
    state.lastArticleId = latest?.id ?? 0;
    state.initialized = true;
    await state.save();
    return [];
  }

  const inputs: NotificationInput[] = diffAreaStatus(Object.fromEntries(state.areaStatus), areas).map(buildFoxStatusNotification);

  const articles = await Article.find({ id: { $gt: state.lastArticleId } }, { id: 1, title: 1, type: 1, endTime: 1 }).sort({ id: 1 }).lean();
  inputs.push(...articles.map(buildArticleNotification));

  // Hunt time can lie before the upload, so look back a bit further than the submit window
  const open = await HuntReport.find(
    { submittedAt: null, deadlineWarnedAt: null, createdAt: { $gte: new Date(now.getTime() - 3 * HUNT_SUBMIT_WINDOW_MS) } },
    { area: 1, huntTime: 1, createdAt: 1, reportedByName: 1, submittedAt: 1, deadlineWarnedAt: 1 },
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
    // Release the claims so the next run re-detects the warnings instead of losing them
    if (claimedIds.length > 0) {
      await HuntReport.updateMany({ _id: { $in: claimedIds }, deadlineWarnedAt: now }, { $set: { deadlineWarnedAt: null } });
    }
    throw error;
  }

  // Merge: areas missing from a partial read keep their last known status
  const areaStatus = new Map(state.areaStatus);
  for (const area of areas) areaStatus.set(area.name, area.status);
  state.areaStatus = areaStatus;
  if (articles.length > 0) state.lastArticleId = articles[articles.length - 1].id;
  await state.save();

  for (const notification of created) {
    Promise.resolve()
      .then(() => send(notification))
      .catch((error) => log.error("Pushing a notification failed", error));
  }
  return created;
}
