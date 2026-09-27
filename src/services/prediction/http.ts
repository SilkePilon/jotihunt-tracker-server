export type Schedule = <T>(task: () => Promise<T>) => Promise<T>;

export type HttpPost = (url: string, body: unknown, config: { headers: Record<string, string>; timeout: number }) => Promise<{ data: unknown }>;

export type HttpGet = (
  url: string,
  config: { params: Record<string, string>; headers: Record<string, string>; timeout: number },
) => Promise<{ data: unknown }>;

export interface ThrottleClock {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run tasks one after another with at least minIntervalMs between their starts.
 * Failed tasks reject their own promise but never block the queue.
 */
export function createThrottle(minIntervalMs: number, clock: ThrottleClock = {}): Schedule {
  const now = clock.now ?? (() => Date.now());
  const sleep = clock.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let chain: Promise<unknown> = Promise.resolve();
  let lastStart = Number.NEGATIVE_INFINITY;

  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(async () => {
      const wait = lastStart + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
      lastStart = now();
      return task();
    });
    chain = run.catch(() => undefined);
    return run;
  };
}

/** Counts calls per UTC day and refuses once the daily limit is reached. */
export class DailyCounter {
  private day = "";
  private count = 0;
  private readonly limit: number;
  private readonly now: () => Date;

  constructor(limit: number, now: () => Date = () => new Date()) {
    this.limit = limit;
    this.now = now;
  }

  tryConsume(): boolean {
    const day = this.now().toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.count = 0;
    }
    if (this.count >= this.limit) return false;
    this.count++;
    return true;
  }
}
