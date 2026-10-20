/** One Jotihunt per year, each in its own database; the registry lives in the control database's `settings`. */
export interface Edition {
  year: number;
  dbName: string;
  createdAt: Date;
  /** ISO strings; null = not set (the live edition then falls back to HUNT_START_TIME/HUNT_END_TIME) */
  huntStart: string | null;
  huntEnd: string | null;
}

export interface EditionsDoc {
  key: "editions";
  editions: Edition[];
  /** The edition the crons, API pulls and trackers write to */
  liveYear: number;
  /** The edition everyone sees; an archive (read-only) when it isn't the live one */
  shownYear: number;
}

export const EDITIONS_KEY = "editions";
/** The first edition this app ran; its data already sits in the control database */
export const FIRST_EDITION_YEAR = 2026;

export type ShowCheck = { ok: true } | { ok: false; status: 404 | 409; message: string };

/** First boot with editions: register the existing data as 2026 (no data moves). */
export function migrateRegistry(existing: EditionsDoc | null, controlDb: string, hunt: { huntStart: string | null; huntEnd: string | null }, now: Date): EditionsDoc {
  if (existing) return existing;
  return {
    key: "editions",
    editions: [{ year: FIRST_EDITION_YEAR, dbName: controlDb, createdAt: now, huntStart: hunt.huntStart, huntEnd: hunt.huntEnd }],
    liveYear: FIRST_EDITION_YEAR,
    shownYear: FIRST_EDITION_YEAR,
  };
}

export function editionOf(doc: EditionsDoc, year: number): Edition | undefined {
  return doc.editions.find((edition) => edition.year === year);
}

export function isArchive(doc: EditionsDoc): boolean {
  return doc.shownYear !== doc.liveYear;
}

/** The next edition (live year + 1) on `<controlDb>-<year>`, live and shown. */
export function nextEditionRegistry(doc: EditionsDoc, controlDb: string, now: Date): EditionsDoc {
  const year = doc.liveYear + 1;
  const edition: Edition = { year, dbName: `${controlDb}-${year}`, createdAt: now, huntStart: null, huntEnd: null };
  return { ...doc, editions: [...doc.editions, edition], liveYear: year, shownYear: year };
}

export function huntRunning(edition: Edition, now: Date): boolean {
  if (!edition.huntStart || !edition.huntEnd) return false;
  const t = now.getTime();
  return t >= new Date(edition.huntStart).getTime() && t <= new Date(edition.huntEnd).getTime();
}

const DURING_HUNT: ShowCheck = { ok: false, status: 409, message: "Archief kan niet tijdens de hunt" };

/** Showing an archive pauses the live crons, so it is refused while the live edition's hunt runs. */
export function checkShow(doc: EditionsDoc, year: number, now: Date): ShowCheck {
  if (!editionOf(doc, year)) return { ok: false, status: 404, message: "Die editie bestaat niet" };
  if (year === doc.liveYear) return { ok: true };
  const live = editionOf(doc, doc.liveYear);
  return live && huntRunning(live, now) ? DURING_HUNT : { ok: true };
}

/** A new edition makes the current live one an archive: same guard. */
export function checkCreate(doc: EditionsDoc, now: Date): ShowCheck {
  const live = editionOf(doc, doc.liveYear);
  return live && huntRunning(live, now) ? { ok: false, status: 409, message: "Nieuwe editie kan niet tijdens de hunt" } : { ok: true };
}
