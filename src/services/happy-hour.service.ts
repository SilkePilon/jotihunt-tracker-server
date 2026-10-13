import { HappyHour } from "../models/happy-hour.model";
import { AppNotification } from "../models/notification.model";
import { runTracked, runTrackedRetrying } from "../demo/demo-mode";
import { sendToAll } from "./push.service";
import { buildHappyHourNotification, happyHourView, parseHappyHourWindow, type HappyHourView } from "./happy-hour.helpers";

export interface HappyHourLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface HappyHourServiceOptions {
  logger: HappyHourLogger;
  /** Tests only */
  now?: () => Date;
  /** Wait between tries while a demo switch is running */
  retryWaitMs?: number;
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
   * A happy-hour message (once per Telegram id). A message overlapping a known window updates that window without a
   * new announcement; a window that has already ended (read late, e.g. after a restart) is stored without alerts.
   */
  async handleMessage(message: { telegramId: number; text: string; date: Date }): Promise<void> {
    const window = parseHappyHourWindow(message.text, message.date);
    const result = await runTrackedRetrying(
      async () => {
        const now = this.now();
        if (await HappyHour.exists({ telegramIds: message.telegramId })) return null;
        const ended = window.endsAt.getTime() <= now.getTime();
        const existing = await HappyHour.findOne({ startsAt: { $lt: window.endsAt }, endsAt: { $gt: window.startsAt } }).sort({ startsAt: 1 });
        if (existing) {
          // A running window keeps its start ("verlengd tot 22:30" sent during it starts "now")
          const startsAt = existing.startsAt.getTime() <= now.getTime() ? existing.startsAt : window.startsAt;
          existing.set({ startsAt, endsAt: window.endsAt, text: message.text, parsed: window.parsed, telegramIds: [...existing.telegramIds, message.telegramId] });
          // Extended past a sent end alert: the new end alerts again
          if (existing.endNotifiedAt && !ended) existing.endNotifiedAt = null;
          await existing.save();
          return { hour: existing.toObject() as HappyHourDoc, notification: null };
        }
        const startsNow = window.startsAt.getTime() <= now.getTime();
        const hour = await HappyHour.create({
          ...window,
          text: message.text,
          telegramIds: [message.telegramId],
          announcedAt: now,
          // Starting now: the announcement is the start alert
          startNotifiedAt: ended || startsNow ? now : null,
          endNotifiedAt: ended ? now : null,
        });
        if (ended) return { hour: hour.toObject() as HappyHourDoc, notification: null };
        const notification = await AppNotification.create(buildHappyHourNotification("announce", hour, now));
        return { hour: hour.toObject() as HappyHourDoc, notification };
      },
      { waitMs: this.options.retryWaitMs },
    );
    if (!result) {
      this.options.logger.error(`Happy hour from Telegram message ${message.telegramId} skipped: a demo switch kept running`);
      return;
    }
    if (!result.value) return;
    const { hour, notification } = result.value;
    if (notification) {
      this.options.logger.info(`Happy hour alert sent: ${notification.body}`);
      void runTracked(() => sendToAll(notification), { generation: result.generation });
    }
    this.schedule(hour);
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
      { waitMs: this.options.retryWaitMs },
    );
    if (early.hour) return this.schedule(early.hour);
    const notification = result?.value;
    if (!notification) return;
    this.options.logger.info(`Happy hour ${phase} alert sent`);
    void runTracked(() => sendToAll(notification), { generation: result.generation });
  }
}
