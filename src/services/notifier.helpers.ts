export const NOTIFICATION_TYPES = ["fox-status", "hint", "article", "hunt-new", "hunt-approved", "hunt-rejected", "broadcast", "counter-hunt", "happy-hour", "hunt-cooldown"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
/** Types a user can switch off; broadcasts from HQ always come through. */
export const OPTIONAL_NOTIFICATION_TYPES = NOTIFICATION_TYPES.filter((type) => type !== "broadcast");

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

const STATUS_NL: Record<string, string> = { green: "groen", orange: "oranje", red: "rood", blue: "met OV" };
const statusNl = (status: string) => STATUS_NL[status] ?? status;
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const clock = (date: Date) => date.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Amsterdam" });

/** Types that no longer exist (stored in old preferences, sent back by older apps) */
export const REMOVED_NOTIFICATION_TYPES = ["hunt-deadline"] as const;

/**
 * Only the switchable types that exist, without duplicates: older apps send back removed types ("hunt-deadline"),
 * which are dropped instead of rejecting the whole save.
 */
export function knownOptionalTypes(types: unknown): string[] {
  if (!Array.isArray(types)) return [];
  return [...new Set(types.filter((type): type is string => typeof type === "string" && (OPTIONAL_NOTIFICATION_TYPES as readonly string[]).includes(type)))];
}

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

export function buildFoxStatusNotification(change: AreaStatusChange): NotificationInput {
  const area = capitalize(change.area);
  const data = { area: change.area, status: change.to, previousStatus: change.from };
  if (change.to === "green") {
    return { type: "fox-status", title: `GROEN: ${area} — jagen mag!`, body: `Was ${statusNl(change.from)}.`, urgent: true, data };
  }
  if (change.to === "blue") {
    return { type: "fox-status", title: `OV: ${area} reist met OV — niet hunten`, body: `Was ${statusNl(change.from)}.`, urgent: false, data };
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

/** A hunt sync log entry, as far as its notification needs it */
export interface HuntSyncNotificationEvent {
  _id: unknown;
  huntId: unknown;
  area: string;
  type: "new" | "approved" | "rejected" | "points";
  points?: number | null;
  huntTime?: Date | null;
  initial?: boolean;
}

/**
 * "Hunt Alpha binnengekomen" / "Hunt Alpha goedgekeurd · +10" / "Hunt Alpha afgekeurd"; null for points changes.
 * The hunter is unknown (jotihunt.nl only shows the fox's device).
 */
export function buildHuntSyncNotification(event: HuntSyncNotificationEvent): NotificationInput | null {
  const area = capitalize(event.area);
  const data = { area: event.area, huntId: String(event.huntId), eventId: String(event._id) };
  if (event.type === "new") {
    return { type: "hunt-new", title: `Hunt ${area} binnengekomen`, body: event.huntTime ? `Geregistreerd om ${clock(event.huntTime)}, wacht op beoordeling.` : "Wacht op beoordeling.", urgent: false, data };
  }
  if (event.type === "approved") {
    const points = event.points ? ` · +${event.points}` : "";
    return { type: "hunt-approved", title: `Hunt ${area} goedgekeurd${points}`, body: "", urgent: false, data: { ...data, points: event.points ?? 0 } };
  }
  if (event.type === "rejected") return { type: "hunt-rejected", title: `Hunt ${area} afgekeurd`, body: "", urgent: false, data };
  return null;
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

/** Rules: after a hunt on a fox we may hunt it again after an hour */
export const HUNT_COOLDOWN_MS = 60 * 60 * 1000;
/** A cooldown that ended longer ago than this is recorded without a push (downtime, late sync of an old hunt) */
export const HUNT_COOLDOWN_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** Newest synced hunt per area that starts a cooldown (no tegenhunts); area lowercase */
export interface LastHunt {
  area: string;
  huntTime: Date;
}

export interface CooldownReady {
  area: string;
  status: "green" | "orange";
  huntTime: Date;
}

/**
 * Areas whose hunt cooldown is over while they are green or orange, each hunt once. `notified` maps a lowercase area
 * to the ISO hunt time already handled; without it (first run, or the first run after this shipped) every last hunt
 * is only recorded. Red/blue areas wait unrecorded so they fire when they turn green/orange; a cooldown that ended
 * more than HUNT_COOLDOWN_MAX_AGE_MS ago is recorded without a push.
 */
export function huntCooldownReady(input: {
  lastHunts: readonly LastHunt[];
  status: Record<string, string>;
  notified: Record<string, string> | null | undefined;
  now: Date;
}): { ready: CooldownReady[]; notified: Record<string, string> } {
  const statusByArea = new Map(Object.entries(input.status).map(([name, status]) => [name.toLowerCase(), status]));
  const notified: Record<string, string> = { ...(input.notified ?? {}) };
  const ready: CooldownReady[] = [];
  for (const { area: rawArea, huntTime } of input.lastHunts) {
    const area = rawArea.toLowerCase();
    const iso = huntTime.toISOString();
    if (!input.notified) {
      notified[area] = iso;
      continue;
    }
    const handled = notified[area] ? Date.parse(notified[area]) : -Infinity;
    if (huntTime.getTime() <= handled) continue;
    const endsAt = huntTime.getTime() + HUNT_COOLDOWN_MS;
    if (endsAt > input.now.getTime()) continue;
    if (input.now.getTime() - endsAt > HUNT_COOLDOWN_MAX_AGE_MS) {
      notified[area] = iso;
      continue;
    }
    const status = statusByArea.get(area);
    if (status !== "green" && status !== "orange") continue;
    ready.push({ area, status, huntTime });
    notified[area] = iso;
  }
  return { ready, notified };
}

export function buildHuntCooldownNotification(ready: CooldownReady): NotificationInput {
  return {
    type: "hunt-cooldown",
    title: `${capitalize(ready.area)} mag weer gehunt worden`,
    body: `${capitalize(statusNl(ready.status))} · laatste hunt ${clock(ready.huntTime)}`,
    urgent: false,
    data: { area: ready.area, status: ready.status, huntTime: ready.huntTime.toISOString() },
  };
}
