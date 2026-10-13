/**
 * The demo mode flag of this process and the work tracking a database switch waits for. Kept in its own module
 * (without database imports) so low-level modules such as the photo store, the OCR queue and the crons can use it
 * without import cycles. Only database-switch.ts changes the flag, the switch state and the generation.
 */
let demoMode = false;
/** True from the moment a switch starts waiting for running work until the default connection is settled again */
let switchInProgress = false;
/** Incremented every time the default connection is about to change database */
let generation = 0;
/** Running HTTP requests (see demoGate) plus running tracked jobs (see runTracked) */
let activeWork = 0;
const idleWaiters = new Set<() => void>();

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

// --- Work tracking ----------------------------------------------------------------------------------------------

/** True while a switch waits for running work or changes the database; tracked jobs are skipped meanwhile. */
export function isDemoSwitchInProgress(): boolean {
  return switchInProgress;
}

/**
 * Database generation: changes on every switch. A long job captures it at the start and must not write when it
 * changed (the default connection then serves another database than the one the job read from).
 */
export function currentGeneration(): number {
  return generation;
}

/** Thrown by `assertGeneration` when the database was switched since the job captured its generation. */
export class DemoSwitchedError extends Error {
  constructor() {
    super("The database was switched while this job was running");
    this.name = "DemoSwitchedError";
  }
}

/** Throw a DemoSwitchedError when the database was switched since `captured`; call right before writing. */
export function assertGeneration(captured: number) {
  if (captured !== generation) throw new DemoSwitchedError();
}

/**
 * Count one unit of work (a request, a job) until the returned function is called (idempotent). A switch waits until
 * no work is counted before it touches the default connection.
 */
export function beginWork(): () => void {
  activeWork++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    activeWork--;
    if (activeWork <= 0) for (const resolve of idleWaiters) resolve();
  };
}

/**
 * Run background work (crons, queues, fire-and-forget tasks) that uses the default Mongoose connection so a switch
 * waits for it. Returns undefined without running `fn` while a switch is in progress, or when `options.generation` is
 * given and the database was switched since it was captured (capture it before slow network calls, then persist in
 * `runTracked(..., { generation })`). Keep tracked work short: a switch fails when work runs longer than 10 s.
 */
export async function runTracked<T>(fn: () => Promise<T>, options: { generation?: number } = {}): Promise<T | undefined> {
  if (switchInProgress) return undefined;
  if (options.generation !== undefined && options.generation !== generation) return undefined;
  const finish = beginWork();
  try {
    return await fn();
  } finally {
    finish();
  }
}

/**
 * runTracked for work that must not be lost (e.g. an alert from a Telegram message): while a switch is in progress it
 * waits and tries again, up to `attempts` times. `fn` gets the generation it runs in (pass it to follow-up work such as
 * a push). Resolves `{ value, generation }`, or undefined when it never ran.
 */
export async function runTrackedRetrying<T>(
  fn: (generation: number) => Promise<T>,
  options: { attempts?: number; waitMs?: number } = {},
): Promise<{ value: T; generation: number } | undefined> {
  const attempts = options.attempts ?? 30;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const captured = generation;
    let ran = false;
    const value = await runTracked(
      async () => {
        ran = true;
        return fn(captured);
      },
      { generation: captured },
    );
    if (ran) return { value: value as T, generation: captured };
    await new Promise<void>((resolve) => setTimeout(resolve, options.waitMs ?? 1_000).unref?.());
  }
  return undefined;
}

/** @internal Used by database-switch.ts only. */
export function setDemoSwitchInProgress(inProgress: boolean) {
  switchInProgress = inProgress;
}

/** @internal Used by database-switch.ts only: a new database generation starts. */
export function nextGeneration() {
  generation++;
}

/** @internal Used by database-switch.ts only: resolves true when no work is counted, false after `timeoutMs`. */
export function waitForIdleWork(timeoutMs: number): Promise<boolean> {
  if (activeWork <= 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const finish = (idle: boolean) => {
      clearTimeout(timer);
      idleWaiters.delete(onIdle);
      resolve(idle);
    };
    const onIdle = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    idleWaiters.add(onIdle);
  });
}

/** @internal Number of counted requests and jobs (logging, tests). */
export function activeWorkCount(): number {
  return activeWork;
}
