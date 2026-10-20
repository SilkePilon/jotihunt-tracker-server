import { GeminiError } from "./gemini-error";

/** Pause of a job after a failure that says Gemini is down or busy; doubles on every next one in a row */
export const GEMINI_JOB_PAUSE_MS = 120_000;
/** Longest pause of a job */
export const GEMINI_JOB_MAX_PAUSE_MS = 900_000;

/** Runs `fn` against the database a run started on, or skips it (undefined) when an edition switch happened meanwhile */
export type Tracked = <T>(fn: () => Promise<T>) => Promise<T | undefined>;

const isOutage = (error: unknown) => error instanceof GeminiError && error.retryable;

/**
 * Background job that lets Gemini work on pending articles, a few per run (`batch`, default 1). `beginRun` gives every
 * run its own `tracked` wrapper, bound to the database the run started on: reading (`findPending`) and storing
 * (`store`) run inside it, the Gemini call (`work`) outside it (it can take long). When a tracked call is skipped (a
 * edition switch happened) the run stops.
 *
 * A retryable failure (Gemini down or busy: 429, 5xx, timeout, network) stops the run and pauses the job:
 * 2 minutes at first, doubling on every next such failure up to 15 minutes, back to 2 after a success. Any other
 * failure counts for the article: after `maxAttempts` of them for the same content (`hashOf`) it is left alone.
 *
 * `store` may return `false`: nothing was stored because the article changed during the Gemini call. That article is
 * neither done nor a failed attempt; `findPending` decides when it is picked up again. Any other return value
 * (`undefined` included) means stored.
 */
export function createGeminiJob<A extends { id: number }, R>({
  findPending,
  work,
  store,
  hashOf,
  beginRun = () => (fn) => fn(),
  maxAttempts = 2,
  batch = 1,
  now = Date.now,
}: {
  findPending: (limit: number) => Promise<A[]>;
  work: (article: A) => Promise<R>;
  store: (article: A, result: R) => Promise<unknown>;
  /** The version of the article's content the attempts are counted for */
  hashOf: (article: A) => string;
  beginRun?: () => Tracked;
  maxAttempts?: number;
  batch?: number;
  now?: () => number;
}) {
  const attempts = new Map<number, { hash: string; count: number }>();
  const givenUp = (article: A) => {
    const entry = attempts.get(article.id);
    return entry?.hash === hashOf(article) && entry.count >= maxAttempts;
  };
  let pausedUntil = 0;
  let nextPause = GEMINI_JOB_PAUSE_MS;

  return {
    async run() {
      const done: number[] = [];
      const failed: { id: number; error: unknown }[] = [];
      if (now() < pausedUntil) return { done, failed };
      const tracked = beginRun();
      // Read a few more than the batch, so articles that were given up on do not block the ones behind them
      const pending = ((await tracked(() => findPending(batch + attempts.size))) ?? []).filter((article) => !givenUp(article)).slice(0, batch);
      for (const article of pending) {
        try {
          const result = await work(article);
          nextPause = GEMINI_JOB_PAUSE_MS;
          const stored = await tracked(async () => (await store(article, result)) !== false);
          // Skipped: an edition switch happened
          if (stored === undefined) break;
          // Changed meanwhile: not done, and not a failure either
          if (!stored) continue;
          attempts.delete(article.id);
          done.push(article.id);
        } catch (error) {
          failed.push({ id: article.id, error });
          if (isOutage(error)) {
            pausedUntil = now() + nextPause;
            nextPause = Math.min(nextPause * 2, GEMINI_JOB_MAX_PAUSE_MS);
            break;
          }
          const entry = attempts.get(article.id);
          const hash = hashOf(article);
          attempts.set(article.id, { hash, count: entry?.hash === hash ? entry.count + 1 : 1 });
        }
      }
      return { done, failed };
    },
  };
}
