import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { clearDemoUploads } from "../services/photo-store";
import { activeWorkCount, beginWork, isDemoMode, nextGeneration, setDemoModeFlag, setDemoSwitchInProgress, waitForIdleWork } from "./demo-mode";
import { openDemoStateStore, type DemoStateStore } from "./demo-state";
import { demoConnectOptions, demoDbName, mongoUriDbName } from "./mongo-uri";

export { demoConnectOptions, demoDbName, mongoUriDbName } from "./mongo-uri";

/** Fills the (freshly dropped, users already copied) demo database; times relative to `now`. */
export type DemoWorldGenerator = (now: Date) => Promise<void>;
/** Called after every switch (on and off), e.g. to clear caches and queues holding data of the other database. */
export type DemoSwitchListener = (enabled: boolean) => void | Promise<void>;

export interface DemoState {
  enabled: boolean;
  enabledAt: Date | null;
  /** When the current demo world was generated (null when demo mode is off) */
  startedAt: Date | null;
}

export interface DemoLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

/** A switch was refused because requests or background jobs kept running; nothing changed. */
export class DemoSwitchBusyError extends Error {
  readonly status = 409;
  constructor() {
    super("Er lopen nog taken; probeer het zo opnieuw.");
    this.name = "DemoSwitchBusyError";
  }
}

/** Max time a switch waits for running requests and tracked jobs; after that the switch is refused. */
const DRAIN_TIMEOUT_MS = 10_000;
let drainTimeoutMs = DRAIN_TIMEOUT_MS;
/** A request whose client is gone counts at most this long after the disconnect when its handler never responds. */
const ABANDONED_REQUEST_MS = 30_000;
let abandonedRequestMs = ABANDONED_REQUEST_MS;

const DISABLED_STATE: DemoState = Object.freeze({ enabled: false, enabledAt: null, startedAt: null });

const noopLogger: DemoLogger = { info() {}, warn() {}, error() {} };

let realUri: string | null = null;
let store: DemoStateStore | null = null;
let log: DemoLogger = noopLogger;
let state: DemoState = DISABLED_STATE;
let generator: DemoWorldGenerator = async () => {};
const listeners = new Set<DemoSwitchListener>();
/** Serialises switches; also what the gate waits for */
let switching: Promise<unknown> | null = null;

// --- Public API -------------------------------------------------------------------------------------------------

/** Injected by the demo world generator (Task 2); the default does nothing (users are copied by the switch). */
export function setDemoWorldGenerator(fn: DemoWorldGenerator) {
  generator = fn;
}

/** Register a callback that runs after every switch; returns an unsubscribe function. */
export function onDemoSwitch(listener: DemoSwitchListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Read-only access to a collection of the REAL database (through the DemoState connection), for the demo generator
 * (teams). Never write through this.
 */
export async function readRealCollection<T = Record<string, unknown>>(collection: string, filter: Record<string, unknown> = {}): Promise<T[]> {
  const { store: stateStore } = requireInit();
  return (await stateStore.connection.collection(collection).find(filter).toArray()) as T[];
}

/** The store on the dedicated connection to the real database (also holds the other `settings` documents). */
export function getDemoStateStore(): DemoStateStore {
  return requireInit().store;
}

export function getDemoState(): DemoState {
  return { ...state };
}

/**
 * Open the DemoState store in the real database and connect the default Mongoose connection: to the real database, or,
 * when demo mode was left on, to a freshly generated demo database.
 */
export async function initDemoMode(
  uri: string,
  options: { logger?: DemoLogger; /** tests only */ drainTimeoutMs?: number; /** tests only */ abandonedRequestMs?: number } = {},
): Promise<DemoState> {
  if (store) throw new Error("Demo mode is already initialised");
  log = options.logger ?? noopLogger;
  drainTimeoutMs = options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
  abandonedRequestMs = options.abandonedRequestMs ?? ABANDONED_REQUEST_MS;
  realUri = uri;
  demoDbName(uri); // refuse to run with an unusable demo database name
  store = await openDemoStateStore(uri);
  const saved = await store.read();
  if (saved?.enabled) {
    log.info("Demo mode is on: starting with a fresh demo database");
    try {
      const startedAt = await enterDemo();
      state = { enabled: true, enabledAt: saved.enabledAt ?? null, startedAt };
      await store.write({ enabled: true, enabledAt: state.enabledAt, enabledBy: saved.enabledBy ?? null, startedAt });
      return getDemoState();
    } catch (error) {
      log.error("Could not start in demo mode, falling back to the real database", error);
      await fallbackToReal();
      await store.write({ ...DISABLED_STATE, enabledBy: null });
      return getDemoState();
    }
  }
  await connectReal();
  state = DISABLED_STATE;
  // A demo database left behind by a failed switch or a crash
  await dropDemoDatabase().catch((error) => log.warn(`Could not drop a leftover demo database: ${describe(error)}`));
  return getDemoState();
}

/**
 * Switch between the real and the demo database. Switching to the current state is a no-op. Rejects with a
 * DemoSwitchBusyError (nothing changed) when requests or tracked jobs keep running for more than 10 s.
 */
export function switchDemoMode(enabled: boolean, user?: { _id: unknown } | null): Promise<DemoState> {
  const previous = switching ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => performSwitch(enabled, user));
  const current = run.finally(() => {
    if (switching === current) switching = null;
  });
  // The caller handles the rejection of `run`; this copy only serialises switches
  current.catch(() => undefined);
  switching = current;
  return run;
}

/**
 * Express middleware (mount before the routes): requests wait for a running switch and are counted, so a switch
 * waits for them before it disconnects the database. A request counts until its handler responded (res.end), also
 * when the client gave up earlier: the handler may still be writing. A request whose client is gone and whose handler
 * never responds stops counting after a while, so it can't block switching forever.
 */
export function demoGate(req: Request, res: Response, next: NextFunction) {
  const start = () => {
    const finish = beginWork();
    let released = false;
    let abandonedTimer: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      released = true;
      clearTimeout(abandonedTimer);
      finish();
    };
    res.on("finish", release);
    res.on("close", () => {
      if (released || abandonedTimer) return;
      if (res.writableFinished) return release();
      abandonedTimer = setTimeout(() => {
        log.warn(`${req.method} ${req.originalUrl} (client gone) still running after ${abandonedRequestMs / 1000} s; no longer delays a demo switch`);
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
  waitForSwitch().then(start, next);
}

/** Express middleware for the /demo routes themselves: waits for a running switch, not counted by it. */
export function waitForDemoSwitch(_req: Request, _res: Response, next: NextFunction) {
  if (!switching) return next();
  waitForSwitch().then(() => next(), next);
}

/** Close the DemoState connection and the default connection; resets the module (tests, shutdown). */
export async function closeDemoMode() {
  await switching?.catch(() => undefined);
  await mongoose.connection.close();
  await store?.close();
  store = null;
  realUri = null;
  state = DISABLED_STATE;
  setDemoModeFlag(false);
  setDemoSwitchInProgress(false);
  generator = async () => {};
}

// --- Internals --------------------------------------------------------------------------------------------------

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForSwitch() {
  while (switching) await switching.catch(() => undefined);
}

function requireInit(): { uri: string; store: DemoStateStore } {
  if (!realUri || !store) throw new Error("Demo mode is not initialised");
  return { uri: realUri, store };
}

/**
 * Index maintenance of the real database (also after switching back from demo mode). model.init() only runs once
 * per process, so the indexes are built with createIndexes(). Hunt codes are no longer unique (duplicates are
 * flagged): syncIndexes drops the old unique index; HuntReport's automatic init() fails on exactly that conflict.
 */
async function maintainIndexes() {
  const models = Object.values(mongoose.models);
  await Promise.all(
    models
      .filter((model) => model.modelName !== "HuntReport")
      .map((model) => model.createIndexes().catch((error) => log.error(`Could not build indexes for ${model.modelName}`, error))),
  );
  const huntReport = models.find((model) => model.modelName === "HuntReport");
  await huntReport?.syncIndexes().catch((error) => log.error("Could not sync indexes for HuntReport", error));
}

/** Only the default connection is closed: mongoose.disconnect() would also close the DemoState connection. */
async function connectReal() {
  const { uri } = requireInit();
  await mongoose.connection.close();
  await mongoose.connect(uri);
  if (mongoose.connection.name !== mongoUriDbName(uri)) {
    await mongoose.connection.close();
    throw new Error("Connected to an unexpected database");
  }
  setDemoModeFlag(false);
  await maintainIndexes();
}

/** Connect the default connection to the existing demo database again (a failed switch-off), without dropping it. */
async function reconnectDemo() {
  const { uri } = requireInit();
  const demoName = demoDbName(uri);
  await mongoose.connection.close();
  await mongoose.connect(uri, demoConnectOptions(uri, demoName));
  if (mongoose.connection.name !== demoName) {
    await mongoose.connection.close();
    throw new Error("Connected to an unexpected database");
  }
  setDemoModeFlag(true);
}

/**
 * Drop the demo database through the DemoState connection, so it works whatever the default connection is doing.
 * Never drops anything but `<realDbName>-demo`.
 */
async function dropDemoDatabase() {
  const { uri, store: stateStore } = requireInit();
  const demoName = demoDbName(uri);
  if (demoName === stateStore.connection.name || demoName === mongoUriDbName(uri)) throw new Error("Refusing to drop a database that is not the demo database");
  await stateStore.connection.useDb(demoName, { useCache: false }).dropDatabase();
}

/** Connect the default connection to a fresh demo database, copy the users and generate the demo world. */
async function enterDemo(): Promise<Date> {
  const { uri, store: stateStore } = requireInit();
  const demoName = demoDbName(uri);
  await mongoose.connection.close();
  await mongoose.connect(uri, demoConnectOptions(uri, demoName));
  const connection = mongoose.connection;
  // Never drop anything but the demo database
  if (connection.name !== demoName || demoName === stateStore.connection.name) {
    await connection.close();
    throw new Error("Refusing to drop a database that is not the demo database");
  }
  setDemoModeFlag(true);
  await connection.dropDatabase();
  // model.init() only runs once per process, so build the indexes of the fresh database explicitly
  await Promise.all(Object.values(mongoose.models).map((model) => model.createIndexes()));
  const users = await stateStore.connection.collection("users").find().toArray();
  if (users.length > 0) await connection.collection("users").insertMany(users);
  // Push endpoints too, so notifications of the demo world reach the devices that were subscribed
  const pushSubscriptions = await stateStore.connection.collection("pushsubscriptions").find().toArray();
  if (pushSubscriptions.length > 0) await connection.collection("pushsubscriptions").insertMany(pushSubscriptions);
  await clearDemoUploads();
  const now = new Date();
  await generator(now);
  log.info(`Demo database ${demoName} ready (${users.length} users copied)`);
  return now;
}

/**
 * After a failed switch-on: back to the real database and drop the half-built demo database. When even the real
 * database is unreachable, the default connection stays closed (never serving the demo database as if it were real).
 */
async function fallbackToReal() {
  state = DISABLED_STATE;
  try {
    await connectReal();
  } catch (error) {
    log.error("Could not reconnect to the real database", error);
    await mongoose.connection.close().catch(() => undefined);
    setDemoModeFlag(false);
  }
  await dropDemoDatabase().catch((error) => log.error("Could not drop the demo database", error));
  await clearDemoUploads().catch((error) => log.error("Could not clear the demo uploads", error));
}

async function switchOn(stateStore: DemoStateStore, user?: { _id: unknown } | null) {
  let startedAt: Date;
  try {
    startedAt = await enterDemo();
  } catch (error) {
    log.error("Could not switch to demo mode, back to the real database", error);
    await fallbackToReal();
    throw error;
  }
  state = { enabled: true, enabledAt: new Date(), startedAt };
  await stateStore.write({ enabled: true, enabledAt: state.enabledAt, enabledBy: user?._id ? String(user._id) : null, startedAt });
}

async function switchOff(stateStore: DemoStateStore) {
  try {
    await connectReal();
  } catch (error) {
    // The demo database still exists (it is dropped only after the real one is connected): stay in demo mode
    log.error("Could not reconnect to the real database, staying in demo mode", error);
    await reconnectDemo().catch(async (demoError) => {
      log.error("Could not reconnect to the demo database either", demoError);
      await mongoose.connection.close().catch(() => undefined);
    });
    throw error;
  }
  state = DISABLED_STATE;
  await dropDemoDatabase().catch((error) => log.error("Could not drop the demo database (dropped at the next start)", error));
  await clearDemoUploads().catch((error) => log.error("Could not clear the demo uploads", error));
  await stateStore.write({ ...DISABLED_STATE, enabledBy: null });
}

async function notifyListeners(enabled: boolean) {
  for (const listener of listeners) {
    try {
      await listener(enabled);
    } catch (error) {
      log.error("Demo switch listener failed", error);
    }
  }
}

async function performSwitch(enabled: boolean, user?: { _id: unknown } | null): Promise<DemoState> {
  const { store: stateStore } = requireInit();
  if (enabled === isDemoMode()) return getDemoState();

  // From here on tracked jobs are skipped; wait for the running requests and jobs, or refuse the switch
  setDemoSwitchInProgress(true);
  if (!(await waitForIdleWork(drainTimeoutMs))) {
    log.warn(`Demo switch refused: ${activeWorkCount()} request(s)/job(s) still running after ${drainTimeoutMs / 1000} s`);
    setDemoSwitchInProgress(false);
    // Nothing changed, but jobs were skipped while waiting (e.g. the OCR queue): let the listeners pick them up
    await notifyListeners(isDemoMode());
    throw new DemoSwitchBusyError();
  }

  nextGeneration();
  let failure: unknown = null;
  try {
    if (enabled) await switchOn(stateStore, user);
    else await switchOff(stateStore);
  } catch (error) {
    failure = error;
  } finally {
    setDemoSwitchInProgress(false);
  }
  // Listeners may start tracked work (e.g. the OCR queue), so they run after the switch is marked done
  await notifyListeners(isDemoMode());
  if (failure) throw failure;
  log.info(`Demo mode ${enabled ? "on" : "off"}`);
  return getDemoState();
}
