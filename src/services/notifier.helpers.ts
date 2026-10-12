import { effectiveHuntTime } from "./hunt-report.helpers";

export const NOTIFICATION_TYPES = ["fox-status", "hint", "article", "hunt-deadline", "broadcast", "counter-hunt"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
/** Types a user can switch off; broadcasts from HQ always come through. */
export const OPTIONAL_NOTIFICATION_TYPES = NOTIFICATION_TYPES.filter((type) => type !== "broadcast");

/** A registered hunt must be submitted within 30 minutes; warn when 10 minutes are left. */
export const HUNT_SUBMIT_WINDOW_MS = 30 * 60 * 1000;
export const DEADLINE_WARNING_AFTER_MS = 20 * 60 * 1000;

export interface NotificationInput {
  type: NotificationType;
  /** Dutch, ready to show */
  title: string;
  body: string;
  urgent: boolean;
  data: Record<string, unknown>;
}

export interface AreaStatusChange {
  area: string;
  from: string;
  to: string;
}

const STATUS_NL: Record<string, string> = { green: "groen", orange: "oranje", red: "rood" };
const statusNl = (status: string) => STATUS_NL[status] ?? status;
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const clock = (date: Date) => date.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Amsterdam" });

export function isTypeEnabled(type: string, disabledTypes: readonly string[]): boolean {
  return type === "broadcast" || !disabledTypes.includes(type);
}

/**
 * Areas whose status changed since the previous run. Areas without a previous status are new (no event), and
 * areas missing from `current` are ignored: the areas cron rewrites the collection, so a read can be partial.
 */
export function diffAreaStatus(previous: Record<string, string>, current: { name: string; status: string }[]): AreaStatusChange[] {
  return current
    .filter((area) => previous[area.name] !== undefined && previous[area.name] !== area.status)
    .map((area) => ({ area: area.name, from: previous[area.name], to: area.status }));
}

export function newArticles<T extends { id: number }>(articles: T[], lastArticleId: number): T[] {
  return articles.filter((article) => article.id > lastArticleId).sort((a, b) => a.id - b.id);
}

interface DeadlineReport {
  huntTime?: Date | null;
  takenAt?: Date | null;
  createdAt: Date;
  submittedAt?: Date | null;
  deadlineWarnedAt?: Date | null;
}

/** Reports that reached 10 minutes before their submit deadline and were neither submitted nor warned about. */
export function dueDeadlineWarnings<T extends DeadlineReport>(reports: T[], now: Date): T[] {
  return reports.filter((report) => {
    if (report.submittedAt || report.deadlineWarnedAt) return false;
    const age = now.getTime() - effectiveHuntTime(report).getTime();
    return age >= DEADLINE_WARNING_AFTER_MS && age < HUNT_SUBMIT_WINDOW_MS;
  });
}

export function buildFoxStatusNotification(change: AreaStatusChange): NotificationInput {
  const area = capitalize(change.area);
  const data = { area: change.area, status: change.to, previousStatus: change.from };
  if (change.to === "green") {
    return { type: "fox-status", title: `GROEN: ${area} — jagen mag!`, body: `Was ${statusNl(change.from)}.`, urgent: true, data };
  }
  return { type: "fox-status", title: `${area} is nu ${statusNl(change.to)}`, body: `Was ${statusNl(change.from)}.`, urgent: false, data };
}

export function buildArticleNotification(article: { id: number; title: string; type: string; endTime?: Date | null }): NotificationInput {
  const data = { articleId: article.id };
  if (article.type === "hint") return { type: "hint", title: "Nieuwe hint", body: article.title, urgent: false, data };
  if (article.type === "assignment") {
    const deadline = article.endTime ? ` (deadline ${clock(article.endTime)})` : "";
    return { type: "article", title: "Nieuwe opdracht", body: `${article.title}${deadline}`, urgent: false, data };
  }
  return { type: "article", title: "Nieuw bericht", body: article.title, urgent: false, data };
}

export function buildDeadlineNotification(
  report: { _id: unknown; area: string; huntTime?: Date | null; takenAt?: Date | null; createdAt: Date; reportedByName: string },
  now: Date,
): NotificationInput {
  const deadline = effectiveHuntTime(report).getTime() + HUNT_SUBMIT_WINDOW_MS;
  const minutes = Math.max(1, Math.ceil((deadline - now.getTime()) / 60000));
  return {
    type: "hunt-deadline",
    title: `Hunt ${capitalize(report.area)} moet over ${minutes} min ingestuurd zijn`,
    body: `Geregistreerd door ${report.reportedByName}, nog niet ingestuurd.`,
    urgent: false,
    data: { area: report.area, huntReportId: String(report._id) },
  };
}

export function buildBroadcastNotification(message: string, from: string): NotificationInput {
  return { type: "broadcast", title: "Bericht van HQ", body: message, urgent: true, data: { from } };
}

/** Wind directions a tegenhunt can come from, in degrees (the Tegenhunt card's choices). */
export const COUNTER_HUNT_DIRECTIONS = [0, 45, 90, 135, 180, 225, 270, 315] as const;
export type CounterHuntDirection = (typeof COUNTER_HUNT_DIRECTIONS)[number];

const DIRECTION_LABEL: Record<CounterHuntDirection, { short: string; name: string; arrow: string }> = {
  0: { short: "N", name: "noord", arrow: "↑" },
  45: { short: "NO", name: "noordoost", arrow: "↗" },
  90: { short: "O", name: "oost", arrow: "→" },
  135: { short: "ZO", name: "zuidoost", arrow: "↘" },
  180: { short: "Z", name: "zuid", arrow: "↓" },
  225: { short: "ZW", name: "zuidwest", arrow: "↙" },
  270: { short: "W", name: "west", arrow: "←" },
  315: { short: "NW", name: "noordwest", arrow: "↖" },
};

export function buildCounterHuntNotification(direction: CounterHuntDirection, from: string): NotificationInput {
  const { short, name, arrow } = DIRECTION_LABEL[direction];
  return {
    type: "counter-hunt",
    title: `Tegenhunt! Richting ${short} ${arrow}`,
    body: `Zoek de sticker binnen 500 m van het clubhuis, richting ${name}.`,
    urgent: true,
    data: { direction, from },
  };
}
