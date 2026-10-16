import { HappyHour } from "../models/happy-hour.model";
import { AppNotification } from "../models/notification.model";
import { runTracked, runTrackedRetrying } from "../demo/demo-mode";
import { sendToAll } from "./push.service";
import { buildHappyHourNotification, happyHourView, isHappyHourEnd, parseHappyHourWindow, type HappyHourView, type HappyHourWindow } from "./happy-hour.helpers";
import type { ServiceLogger } from "../utils/service-logger";

export interface HappyHourServiceOptions {
  logger: ServiceLogger;
  /** Tests only */
  now?: () => Date;
  /** Wait between tries while a demo switch is running, and how often to try */
  retryWaitMs?: number;
  attempts?: number;
}

/** An end alert later than this (server was down at the end) is skipped: everyone has noticed by then. */
const LATE_END_MS = 10 * 60_000;
/** setTimeout's limit; longer waits are re-armed when they fire */
const MAX_TIMER_MS = 2 ** 31 - 1;

type HappyHourDoc = { _id: unknown; startsAt: Date; endsAt: Date; startNotifiedAt?: Date | null; endNotifiedAt?: Date | null };

/** GET /happy-hour: the first window that has not ended, in the current database. */
export async function currentHappyHour(now = new Date()): Promise<HappyHourView> {
  const hour = await HappyHour.findOne({ endsAt: { $gt: now } }).sort({ startsAt: 1 }).lean();
  return happyHourView(hour ? { startsAt: hour.startsAt, endsAt: hour.endsAt, text: hour.text ?? "" } : null, now);
}

/**
 * Happy hours from @Jotihunt_bot messages: stores the window, alerts on the message, and at the start (when it was
 * announced for later) and the end with in-process timers. The timers are rebuilt from the database at startup and
 * after a demo switch (one server replica).
 */
export class HappyHourService {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>[]>();

  constructor(private readonly options: HappyHourServiceOptions) {}

  private now() {
    return this.options.now?.() ?? new Date();
  }

  /**
   * A happy-hour message (once per Telegram id). A message with times overlapping a known window updates that window
   * without a new announcement. A message without times ("Happy hour is begonnen!") or about the end ("… is
   * voorbij") never changes a window, it is only recorded on it; without any window a start without times is the
   * coming hour, an end message is ignored. A window that has already ended (read late) is stored without alerts.
   * Throws when it could not be handled (the caller retries the message later).
   */
  async handleMessage(message: { telegramId: number; text: string; date: Date }): Promise<void> {
    const window = parseHappyHourWindow(message.text, message.date);
    const isEnd = isHappyHourEnd(message.text);
    const result = await runTrackedRetrying(
      async () => {
        const now = this.now();
        const known = await HappyHour.findOne({ telegramIds: message.telegramId });
        // Known and announced (or merged): done. Known but not announced: a previous try failed halfway.
        if (known?.announcedAt) return null;
        const hour = known ?? (await this.storeWindow(message, window, isEnd, now));
        if (!hour || hour.announcedAt) return hour ? { hour: hour.toObject() as HappyHourDoc, notification: null } : null;
        const ended = hour.endsAt.getTime() <= now.getTime();
        const notification = ended ? null : await AppNotification.create(buildHappyHourNotification("announce", hour, now));
        await HappyHour.updateOne({ _id: hour._id }, { $set: { announcedAt: now } });
        return { hour: hour.toObject() as HappyHourDoc, notification };
      },
      { waitMs: this.options.retryWaitMs, attempts: this.options.attempts },
    );
    if (!result) throw new Error(`Happy hour from Telegram message ${message.telegramId} not handled: a demo switch kept running`);
    if (!result.value) return;
    const { hour, notification } = result.value;
    if (notification) {
      this.options.logger.info(`Happy hour alert sent: ${notification.body}`);
      void runTracked(() => sendToAll(notification), { generation: result.generation });
    }
    this.schedule(hour);
  }

  /**
   * Store the message's window: merged into an overlapping one (returned with announcedAt set, so no new alert), a
   * new one (announcedAt null: still to announce), or nothing (an end message without a window).
   */
  private async storeWindow(message: { telegramId: number; text: string }, window: HappyHourWindow, isEnd: boolean, now: Date) {
    const record = (hour: { _id: unknown }) => HappyHour.findOneAndUpdate({ _id: hour._id }, { $addToSet: { telegramIds: message.telegramId } }, { returnDocument: "after" });
    if (isEnd || !window.parsed) {
      // The window this message is about: one running at the message, else the latest that has not ended
      const current =
        (await HappyHour.findOne({ startsAt: { $lte: window.startsAt }, endsAt: { $gt: window.startsAt } }).sort({ startsAt: -1 })) ??
        (await HappyHour.findOne({ endsAt: { $gt: window.startsAt } }).sort({ startsAt: 1 }));
      if (current) return record(current);
      if (isEnd) return null;
    } else {
      const existing = await HappyHour.findOne({ startsAt: { $lt: window.endsAt }, endsAt: { $gt: window.startsAt } }).sort({ startsAt: 1 });
      if (existing) {
        const ended = window.endsAt.getTime() <= now.getTime();
        // A running window keeps its start ("verlengd tot 22:30" sent during it starts "now")
        const startsAt = existing.startsAt.getTime() <= now.getTime() ? existing.startsAt : window.startsAt;
        existing.set({ startsAt, endsAt: window.endsAt, text: message.text, parsed: true, telegramIds: [...existing.telegramIds, message.telegramId] });
        // Extended past a sent end alert: the new end alerts again
        if (existing.endNotifiedAt && !ended) existing.endNotifiedAt = null;
        return existing.save();
      }
    }
    const ended = window.endsAt.getTime() <= now.getTime();
    return HappyHour.create({
      ...window,
      text: message.text,
      telegramIds: [message.telegramId],
      announcedAt: null,
      // Starting now: the announcement is the start alert
      startNotifiedAt: ended || window.startsAt.getTime() <= now.getTime() ? now : null,
      endNotifiedAt: ended ? now : null,
    });
  }

  /** Re-arm the start/end timers from the current database (startup, after a demo switch). */
  async rebuild(): Promise<void> {
    this.stop();
    const open = await HappyHour.find({ $or: [{ startNotifiedAt: null }, { endNotifiedAt: null }] }).lean();
    for (const hour of open) this.schedule(hour);
  }

  stop() {
    for (const timers of this.timers.values()) timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
  }

  private schedule(hour: HappyHourDoc) {
    const id = String(hour._id);
    for (const timer of this.timers.get(id) ?? []) clearTimeout(timer);
    const timers: ReturnType<typeof setTimeout>[] = [];
    const now = this.now().getTime();
    const arm = (phase: "start" | "end", at: Date) => {
      const timer = setTimeout(() => {
        this.fire(id, phase).catch((error) => this.options.logger.error(`Happy hour ${phase} alert failed`, error));
      }, Math.min(Math.max(at.getTime() - now, 0), MAX_TIMER_MS));
      timer.unref?.();
      timers.push(timer);
    };
    if (!hour.startNotifiedAt) arm("start", hour.startsAt);
    if (!hour.endNotifiedAt) arm("end", hour.endsAt);
    if (timers.length > 0) this.timers.set(id, timers);
    else this.timers.delete(id);
  }

  /** The start or end alert, once (compare-and-set on its *NotifiedAt field). Early timers re-arm. */
  private async fire(id: string, phase: "start" | "end") {
    const early: { hour: HappyHourDoc | null } = { hour: null };
    const result = await runTrackedRetrying(
      async () => {
        const hour = await HappyHour.findById(id).lean();
        if (!hour) return null;
        const now = this.now();
        const due = phase === "start" ? hour.startsAt : hour.endsAt;
        if (due.getTime() > now.getTime() + 1_000) {
          early.hour = hour;
          return null;
        }
        const field = phase === "start" ? "startNotifiedAt" : "endNotifiedAt";
        const claimed = await HappyHour.findOneAndUpdate({ _id: id, [field]: null }, { $set: { [field]: now } });
        if (!claimed) return null;
        // A start that was missed until the end, or an end long past (server was down): nothing to say anymore
        if (phase === "start" && hour.endsAt.getTime() <= now.getTime()) return null;
        if (phase === "end" && now.getTime() - hour.endsAt.getTime() > LATE_END_MS) return null;
        return AppNotification.create(buildHappyHourNotification(phase, hour, now));
      },
      { waitMs: this.options.retryWaitMs, attempts: this.options.attempts },
    );
    if (early.hour) return this.schedule(early.hour);
    const notification = result?.value;
    if (!notification) return;
    this.options.logger.info(`Happy hour ${phase} alert sent`);
    void runTracked(() => sendToAll(notification), { generation: result.generation });
  }
}
