/**
 * The demo mode flag of this process. Kept in its own module (without database imports) so low-level modules such as
 * the photo store and the crons can read it without import cycles. Only database-switch.ts changes it.
 */
let demoMode = false;

/** True while the default Mongoose connection serves the demo database. */
export function isDemoMode(): boolean {
  return demoMode;
}

/** @internal Used by database-switch.ts only. */
export function setDemoModeFlag(enabled: boolean) {
  demoMode = enabled;
}

/**
 * For the jotihunt.nl crons: true (after a debug log) when the run must be skipped because demo mode is on.
 * Usage: `if (skipInDemoMode("jotihunt-areas", (message) => logger.debug(message))) return;`
 */
export function skipInDemoMode(job: string, debug: (message: string) => void): boolean {
  if (!demoMode) return false;
  debug(`(CRON) Skipping ${job}: demo mode is on`);
  return true;
}
