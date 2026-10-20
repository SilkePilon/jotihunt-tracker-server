import { jotihuntLogin } from "./jotihunt-scraper.service";

/** The hunt sync with jotihunt.nl as GET /hunts/sync shows it, without the hunt counts (those come from the database) */
export interface HuntSyncStateView {
  /** A jotihunt.nl login is set in Beheer */
  configured: boolean;
  /** A scrape is in progress right now */
  running: boolean;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  /** Short Dutch text of the last failed run; null once a run succeeds */
  lastError: string | null;
}

/** Kept in memory: after a restart the first run (within a minute) fills it again */
let running = false;
let lastSuccessAt: Date | null = null;
let lastAttemptAt: Date | null = null;
let lastError: string | null = null;

export function markSyncStart(at = new Date()): void {
  running = true;
  lastAttemptAt = at;
}

export function markSyncSuccess(at = new Date()): void {
  running = false;
  lastSuccessAt = at;
  lastError = null;
}

export function markSyncFailure(error: unknown, _at = new Date()): void {
  running = false;
  lastError = syncErrorText(error);
}

/** The run ended without success or failure (e.g. skipped by an edition switch) */
export function markSyncSettled(): void {
  running = false;
}

/** A short Dutch text for the sync card: the site is down or slow, the login is wrong, or something else */
export function syncErrorText(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (/login/i.test(message)) return "Inloggen bij jotihunt.nl mislukt";
  if (/unknown hunts layout|no score card/i.test(message)) return "jotihunt.nl ziet er anders uit";
  if (name === "TimeoutError" || /took longer|timeout|timed out|net::ERR_|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(message)) return "jotihunt.nl reageert niet";
  return "Synchroniseren mislukt";
}

export function syncStateView(): HuntSyncStateView {
  return {
    configured: jotihuntLogin() !== null,
    running,
    lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
    lastAttemptAt: lastAttemptAt?.toISOString() ?? null,
    lastError,
  };
}

/** For tests */
export function resetSyncState(): void {
  running = false;
  lastSuccessAt = null;
  lastAttemptAt = null;
  lastError = null;
}
