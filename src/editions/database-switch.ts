import type { NextFunction, Request, Response } from "express";
import mongoose, { type Connection } from "mongoose";
import { redactPath } from "../sentry";
import { activeWorkCount, beginWork, nextGeneration, setArchiveFlag, setSwitchInProgress, waitForIdleWork } from "./work-tracking";
import { openControlStore, type ControlStore } from "./control-store";
import { dbConnectOptions, mongoUriDbName } from "./mongo-uri";
import { checkCreate, checkShow, editionOf, isArchive, migrateRegistry, nextEditionRegistry, type Edition, type EditionsDoc } from "./registry";
import { errorText } from "../utils/error-text";
import { ServiceError } from "../http/service-error";
import type { HuntTimesSource } from "../settings/app-config";
import { dropLegacyHuntCodeIndex } from "../models/hunt.model";
import type { ServiceLogger } from "../utils/service-logger";

/** Called after every switch (also a refused one), e.g. to clear caches and queues holding data of the other database. */
export type EditionSwitchListener = (registry: EditionsDoc) => void | Promise<void>;

/** A switch was refused because requests or background jobs kept running; nothing changed. */
export class SwitchBusyError extends Error {
  readonly status = 409;
  constructor() {
    super("Er lopen nog taken; probeer het zo opnieuw.");
    this.name = "SwitchBusyError";
  }
}

/** A switch the registry refuses (unknown year, during the live hunt); mapped by the global error handler. */
export class EditionRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "EditionRequestError";
  }
}

/** Max time a switch waits for running requests and tracked jobs; after that the switch is refused. */
const DRAIN_TIMEOUT_MS = 10_000;
let drainTimeoutMs = DRAIN_TIMEOUT_MS;
/** A request whose client is gone counts at most this long after the disconnect when its handler never responds. */
const ABANDONED_REQUEST_MS = 30_000;
let abandonedRequestMs = ABANDONED_REQUEST_MS;

const noopLogger: ServiceLogger = { info() {}, warn() {}, error() {} };

let controlUri: string | null = null;
let store: ControlStore | null = null;
let registry: EditionsDoc | null = null;
let now: () => Date = () => new Date();
let log: ServiceLogger = noopLogger;
const listeners = new Set<EditionSwitchListener>();
/** Serialises switches; also what the gate waits for */
let switching: Promise<unknown> | null = null;
/** The gate's release of each counted response (see releaseSwitchWork) */
const gateReleases = new WeakMap<object, () => void>();

/** A planned switch: the registry to switch to, plus work to do on the new connection before it is saved. */
interface SwitchPlan {
  next: EditionsDoc;
  prepare?: () => Promise<void>;
}

// --- Public API -------------------------------------------------------------------------------------------------

/** The edition registry (a copy). */
export function getRegistry(): EditionsDoc {
  const { registry: current } = requireInit();
  return { ...current, editions: current.editions.map((edition) => ({ ...edition })) };
}

/** The shown edition (a copy), or null before initEditions (tests and scripts on a plain connection). */
export function shownEdition(): Edition | null {
  if (!registry) return null;
  const edition = editionOf(registry, registry.shownYear);
  return edition ? { ...edition } : null;
}

/** The store on the dedicated connection to the control database (also holds the other `settings` documents). */
export function getControlStore(): ControlStore {
  return requireInit().store;
}

/** Read-only access to a collection of the control database. Never write through this. */
export async function readControlCollection<T = Record<string, unknown>>(collection: string, filter: Record<string, unknown> = {}): Promise<T[]> {
  return (await requireInit().store.connection.collection(collection).find(filter).toArray()) as T[];
}

/**
 * The connection to the live edition's database: it holds the master copy of the users and push subscriptions (an
 * archive gets a copy when it is shown). Null before initEditions (tests and scripts on a plain connection).
 */
export function liveConnection(): Connection | null {
  if (!store || !registry) return null;
  const live = editionOf(registry, registry.liveYear)!;
  return live.dbName === store.connection.name ? store.connection : store.connection.useDb(live.dbName, { useCache: true });
}

/**
 * Hunt times of the shown edition (its registry entry), for app-config. An archive is read-only: writing its hunt
 * times fails with 423 before anything is saved.
 */
export function editionHuntTimesSource(): HuntTimesSource {
  return {
    read() {
      const current = requireInit().registry;
      const edition = editionOf(current, current.shownYear)!;
      return { huntStart: edition.huntStart, huntEnd: edition.huntEnd };
    },
    async write(patch) {
      const current = requireInit().registry;
      if (isArchive(current)) throw new ServiceError(423, "Archief is alleen-lezen");
      await updateEditionHuntTimes(current.shownYear, patch);
    },
  };
}

/** Register a callback that runs after every switch; returns an unsubscribe function. */
export function onEditionSwitch(listener: EditionSwitchListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Open the control store, register the existing data as 2026 on first boot, remove the old demo leftovers and connect
 * the default Mongoose connection to the shown edition.
 */
export async function initEditions(
  uri: string,
  options: {
    logger?: ServiceLogger;
    /** tests only */ drainTimeoutMs?: number;
    /** tests only */ abandonedRequestMs?: number;
    /** tests only */ now?: () => Date;
    /** tests only (default process.env) */ env?: Record<string, string | undefined>;
  } = {},
): Promise<EditionsDoc> {
  if (store) throw new Error("Editions are already initialised");
  log = options.logger ?? noopLogger;
  drainTimeoutMs = options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
  abandonedRequestMs = options.abandonedRequestMs ?? ABANDONED_REQUEST_MS;
  now = options.now ?? (() => new Date());
  const controlDb = mongoUriDbName(uri);
  controlUri = uri;
  store = await openControlStore(uri);

  const saved = await store.readRegistry();
  if (!saved) {
    // One-off: hunt times from Beheer (app-config), else HUNT_START_TIME/HUNT_END_TIME; after this only the registry counts
    const general = (await store.connection.collection("settings").findOne({ key: "app-config" }))?.general ?? {};
    const env = options.env ?? process.env;
    const hunt = {
      huntStart: isoTime(general.huntStart) ?? isoTime(env.HUNT_START_TIME),
      huntEnd: isoTime(general.huntEnd) ?? isoTime(env.HUNT_END_TIME),
    };
    registry = migrateRegistry(null, controlDb, hunt, now());
    await store.writeRegistry(registry);
    log.info(`Editions: registered the existing data as Jotihunt ${registry.liveYear}`);
  } else registry = saved;

  // Demo mode is gone: its switch document and a leftover demo database
  if (await store.deleteDemoDoc()) log.info("Removed the old demo mode setting");
  await store.connection
    .useDb(`${controlDb}-demo`, { useCache: false })
    .dropDatabase()
    .catch((error) => log.warn(`Could not drop the old demo database: ${errorText(error)}`));

  const shown = editionOf(registry, registry.shownYear);
  if (!shown) throw new Error(`The shown edition ${registry.shownYear} is not in the registry`);
  await connectEdition(shown, registry, editionOf(registry, registry.liveYear)!.dbName);
  return getRegistry();
}

/** Show `year` to everyone. Rejects with EditionRequestError (404/409) or SwitchBusyError; nothing changes then. */
export function showEdition(year: number): Promise<EditionsDoc> {
  return enqueue(() =>
    performSwitch((current) => {
      if (year === current.shownYear) return null;
      const check = checkShow(current, year, now());
      if (!check.ok) throw new EditionRequestError(check.status, check.message);
      return { next: { ...current, shownYear: year } };
    }),
  );
}

/** Start the next edition (live year + 1): fresh database, night areas copied, live and shown. */
export function createEdition(): Promise<EditionsDoc> {
  return enqueue(() =>
    performSwitch((current) => {
      const check = checkCreate(current, now());
      if (!check.ok) throw new EditionRequestError(check.status, check.message);
      const previousLive = editionOf(current, current.liveYear)!;
      return {
        next: nextEditionRegistry(current, mongoUriDbName(requireInit().uri), now()),
        // Hand-drawn forests don't move between years
        async prepare() {
          const nightAreas = await requireInit()
            .store.connection.useDb(previousLive.dbName, { useCache: true })
            .collection("settings")
            .findOne({ key: "night-areas" }, { projection: { _id: 0 } });
          if (nightAreas) await mongoose.connection.collection("settings").replaceOne({ key: "night-areas" }, nightAreas, { upsert: true });
        },
      };
    }),
  );
}

/** Hunt times live on the registry entry (Beheer → Hunt card edits the shown edition). No database switch. */
export async function updateEditionHuntTimes(year: number, patch: { huntStart?: string | null; huntEnd?: string | null }): Promise<EditionsDoc> {
  const { registry: current, store: control } = requireInit();
  if (!editionOf(current, year)) throw new EditionRequestError(404, "Die editie bestaat niet");
  const next: EditionsDoc = { ...current, editions: current.editions.map((edition) => (edition.year === year ? { ...edition, ...patch } : edition)) };
  await control.writeRegistry(next);
  registry = next;
  return getRegistry();
}

/**
 * Express middleware (mount before the routes): requests wait for a running switch and are counted, so a switch
 * waits for them before it disconnects the database. A request counts until its handler responded (res.end), also
 * when the client gave up earlier: the handler may still be writing. A request whose client is gone and whose handler
 * never responds stops counting after a while, so it can't block switching forever; a GET/HEAD stops counting as soon
 * as its client is gone.
 */
export function editionGate(req: Request, res: Response, next: NextFunction) {
  const start = () => {
    const finish = beginWork();
    const isRead = req.method === "GET" || req.method === "HEAD";
    let released = false;
    let abandonedTimer: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      released = true;
      clearTimeout(abandonedTimer);
      finish();
    };
    gateReleases.set(res, release);
    res.on("finish", release);
    res.on("close", () => {
      if (released || abandonedTimer) return;
      // A read whose client is gone can't write into the wrong database, so it never holds a switch (an aborted
      // photo download in sendFile may not respond for a long time)
      if (res.writableFinished || isRead) return release();
      abandonedTimer = setTimeout(() => {
        log.warn(`${req.method} ${redactPath(req.originalUrl)} (client gone) still running after ${abandonedRequestMs / 1000} s; no longer delays a switch`);
        released = true;
        finish();
      }, abandonedRequestMs);
      abandonedTimer.unref?.();
    });
    // The handler is done once it responds, whether or not the client is still there to receive it
    const end = res.end;
    if (typeof end === "function") {
      res.end = function (this: Response, ...args: Parameters<Response["end"]>) {
        const result = end.apply(this, args);
        release();
        return result;
      } as Response["end"];
    }
    next();
  };
  if (!switching) return start();
  waitForRunningSwitch().then(start, next);
}

/**
 * A long-lived response (the Intel chat stream) stops delaying a switch from here on. Whatever its handler writes
 * later must be counted on its own (beginWork) and check the database generation it started in.
 */
export function releaseSwitchWork(res: Response) {
  gateReleases.get(res)?.();
}

/** Express middleware for the /editions routes themselves: waits for a running switch, not counted by it. */
export function waitForSwitch(_req: Request, _res: Response, next: NextFunction) {
  if (!switching) return next();
  waitForRunningSwitch().then(() => next(), next);
}

/** Close the control connection and the default connection; resets the module (tests, shutdown). */
export async function closeEditions() {
  await switching?.catch(() => undefined);
  await mongoose.connection.close();
  await store?.close();
  store = null;
  controlUri = null;
  registry = null;
  now = () => new Date();
  listeners.clear();
  setArchiveFlag(false);
  setSwitchInProgress(false);
}

// --- Internals --------------------------------------------------------------------------------------------------

/** An ISO time, or null for a missing or invalid value. */
function isoTime(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function requireInit(): { uri: string; store: ControlStore; registry: EditionsDoc } {
  if (!controlUri || !store || !registry) throw new Error("Editions are not initialised");
  return { uri: controlUri, store, registry };
}

async function waitForRunningSwitch() {
  while (switching) await switching.catch(() => undefined);
}

/** Serialises switches; `switching` is also what editionGate waits for. */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const previous = switching ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const current = run.finally(() => {
    if (switching === current) switching = null;
  });
  // The caller handles the rejection of `run`; this copy only serialises switches
  current.catch(() => undefined);
  switching = current;
  return run;
}

/** Models whose old unique hunt-code index must be dropped: syncIndexes instead of createIndexes. */
const SYNCED_MODELS = ["Hunt"];

/**
 * Index maintenance of the edition database the default connection just connected to. model.init() only runs once
 * per process, so the indexes are built with createIndexes(). Hunt codes are no longer unique: synced hunts may have no
 * code at all (QR flow, keyed by siteKey). syncIndexes drops the old unique index.
 */
async function maintainIndexes() {
  const models = Object.values(mongoose.models);
  await Promise.all(
    models
      .filter((model) => !SYNCED_MODELS.includes(model.modelName))
      .map((model) => model.createIndexes().catch((error) => log.error(`Could not build indexes for ${model.modelName}`, error))),
  );
  await dropLegacyHuntCodeIndex().catch((error) => log.error("Could not drop the old unique hunt code index", error));
  for (const model of models.filter((model) => SYNCED_MODELS.includes(model.modelName))) {
    await model.syncIndexes().catch((error) => log.error(`Could not sync indexes for ${model.modelName}`, error));
  }
}

/**
 * Point the default connection at `edition`. `sourceDbName` is the live edition's database before the switch: it holds
 * the master copy of the users and push subscriptions (see auth/user-store.ts). Any other edition gets a copy of them,
 * replacing what it had; the source itself is never overwritten. Only the default connection is closed:
 * mongoose.disconnect() would also close the control connection.
 */
async function connectEdition(edition: Edition, target: EditionsDoc, sourceDbName: string) {
  const { uri, store: control } = requireInit();
  const controlDb = mongoUriDbName(uri);
  await mongoose.connection.close();
  await mongoose.connect(uri, edition.dbName === controlDb ? {} : dbConnectOptions(uri, edition.dbName));
  if (mongoose.connection.name !== edition.dbName) {
    await mongoose.connection.close();
    throw new Error("Connected to an unexpected database");
  }
  if (edition.dbName !== sourceDbName) {
    const source = sourceDbName === control.connection.name ? control.connection : control.connection.useDb(sourceDbName, { useCache: true });
    for (const collection of ["users", "pushsubscriptions"]) {
      const docs = await source.collection(collection).find().toArray();
      await mongoose.connection.collection(collection).deleteMany({});
      if (docs.length > 0) await mongoose.connection.collection(collection).insertMany(docs);
    }
  }
  setArchiveFlag(isArchive(target));
  await maintainIndexes();
}

async function notifyListeners(current: EditionsDoc) {
  for (const listener of listeners) {
    try {
      await listener(current);
    } catch (error) {
      log.error("Edition switch listener failed", error);
    }
  }
}

/**
 * Drain, connect to the planned edition, run its `prepare` on the new connection, persist. On failure: back to the
 * previous edition. `plan` runs on the current registry before the drain (fail fast; null = nothing to do) and again
 * after it, so hunt times saved by a request the drain waited for are not overwritten by a stale copy.
 */
async function performSwitch(plan: (current: EditionsDoc) => SwitchPlan | null): Promise<EditionsDoc> {
  if (!plan(requireInit().registry)) return getRegistry();

  // From here on tracked jobs are skipped; wait for the running requests and jobs, or refuse the switch
  setSwitchInProgress(true);
  if (!(await waitForIdleWork(drainTimeoutMs))) {
    log.warn(`Edition switch refused: ${activeWorkCount()} request(s)/job(s) still running after ${drainTimeoutMs / 1000} s`);
    setSwitchInProgress(false);
    // Nothing changed, but jobs were skipped while waiting (e.g. the AI jobs): let the listeners pick them up
    await notifyListeners(requireInit().registry);
    throw new SwitchBusyError();
  }

  const { registry: previous, store: control } = requireInit();
  let planned: SwitchPlan | null;
  try {
    planned = plan(previous);
  } catch (error) {
    setSwitchInProgress(false);
    await notifyListeners(previous);
    throw error;
  }
  if (!planned) {
    setSwitchInProgress(false);
    await notifyListeners(previous);
    return getRegistry();
  }
  const { next, prepare } = planned;

  // The live edition before the switch has the master users (also for createEdition: the old live one)
  const sourceDbName = editionOf(previous, previous.liveYear)!.dbName;
  nextGeneration();
  let failure: unknown = null;
  try {
    await connectEdition(editionOf(next, next.shownYear)!, next, sourceDbName);
    await prepare?.();
    await control.writeRegistry(next);
    registry = next;
  } catch (error) {
    failure = error;
    log.error("Edition switch failed, back to the previous edition", error);
    await connectEdition(editionOf(previous, previous.shownYear)!, previous, sourceDbName).catch(async (backError) => {
      log.error("Could not reconnect to the previous edition either", backError);
      await mongoose.connection.close().catch(() => undefined);
    });
  } finally {
    setSwitchInProgress(false);
  }
  // Listeners may start tracked work (e.g. the AI jobs), so they run after the switch is marked done
  await notifyListeners(requireInit().registry);
  if (failure) throw failure;
  log.info(`Showing Jotihunt ${next.shownYear}${isArchive(next) ? " (archive)" : ""}`);
  return getRegistry();
}
