import type { NextFunction, Request, Response } from "express";
import mongoose, { type ConnectOptions } from "mongoose";
import { clearDemoUploads } from "../services/photo-store";
import { isDemoMode, setDemoModeFlag } from "./demo-mode";
import { openDemoStateStore, type DemoStateStore } from "./demo-state";

export { isDemoMode, skipInDemoMode } from "./demo-mode";

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

/** Max time a switch waits for requests that are already running before it disconnects the database. */
const DRAIN_TIMEOUT_MS = 10_000;

const noopLogger: DemoLogger = { info() {}, warn() {}, error() {} };

let realUri: string | null = null;
let store: DemoStateStore | null = null;
let log: DemoLogger = noopLogger;
let state: DemoState = { enabled: false, enabledAt: null, startedAt: null };
let generator: DemoWorldGenerator = async () => {};
const listeners = new Set<DemoSwitchListener>();
/** Serialises switches; also what the gate waits for */
let switching: Promise<unknown> | null = null;
let activeRequests = 0;
const drainWaiters = new Set<() => void>();

// --- Database names ---------------------------------------------------------------------------------------------

const URI_PATTERN = /^(mongodb(?:\+srv)?:\/\/[^/?#]*)(?:\/([^?#]*))?(\?[^#]*)?$/;

/** Database name in a MongoDB connection string (the driver's default "test" when it has none). */
export function mongoUriDbName(uri: string): string {
  const match = URI_PATTERN.exec(uri.trim());
  if (!match) throw new Error("Invalid MongoDB connection string");
  return decodeURIComponent(match[2] ?? "") || "test";
}

/** Name of the demo database belonging to a real connection string: `<realDbName>-demo`. */
export function demoDbName(uri: string): string {
  const real = mongoUriDbName(uri);
  const demo = `${real}-demo`;
  if (demo === real) throw new Error("Demo database name equals the real database name");
  return demo;
}

/**
 * Connect options for another database on the same server. The URI stays untouched (it may hold credentials and
 * several hosts); `dbName` selects the database. Without an explicit authSource the driver would authenticate against
 * the selected database, so keep authenticating where the real connection does.
 */
function connectOptions(uri: string, dbName: string): ConnectOptions {
  const match = URI_PATTERN.exec(uri.trim());
  const hasCredentials = !!match && match[1].includes("@");
  const hasAuthSource = /[?&]authSource=/i.test(match?.[3] ?? "");
  const authSource = hasCredentials && !hasAuthSource ? decodeURIComponent(match?.[2] ?? "") || "admin" : undefined;
  return authSource ? { dbName, authSource } : { dbName };
}

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

export function getDemoState(): DemoState {
  return { ...state };
}

/**
 * Open the DemoState store in the real database and connect the default Mongoose connection: to the real database, or,
 * when demo mode was left on, to a freshly generated demo database.
 */
export async function initDemoMode(uri: string, options: { logger?: DemoLogger } = {}): Promise<DemoState> {
  if (store) throw new Error("Demo mode is already initialised");
  log = options.logger ?? noopLogger;
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
      await connectReal();
      state = { enabled: false, enabledAt: null, startedAt: null };
      await store.write({ enabled: false, enabledAt: null, enabledBy: null, startedAt: null });
      return getDemoState();
    }
  }
  await connectReal();
  state = { enabled: false, enabledAt: null, startedAt: null };
  return getDemoState();
}

/** Switch between the real and the demo database. Switching to the current state is a no-op. */
export function switchDemoMode(enabled: boolean, user?: { _id: unknown } | null): Promise<DemoState> {
  const previous = switching ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => performSwitch(enabled, user));
  const current = run.finally(() => {
    if (switching === current) switching = null;
  });
  switching = current;
  return run;
}

/**
 * Express middleware (mount before the routes): requests wait for a running switch and are counted, so a switch
 * waits for them before it disconnects the database.
 */
export function demoGate(req: Request, res: Response, next: NextFunction) {
  const start = () => {
    activeRequests++;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      activeRequests--;
      if (activeRequests <= 0) for (const resolve of drainWaiters) resolve();
    };
    res.on("finish", finish);
    res.on("close", finish);
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
  state = { enabled: false, enabledAt: null, startedAt: null };
  setDemoModeFlag(false);
  generator = async () => {};
}

// --- Internals --------------------------------------------------------------------------------------------------

async function waitForSwitch() {
  while (switching) await switching.catch(() => undefined);
}

function drainRequests(): Promise<void> {
  if (activeRequests <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      drainWaiters.delete(done);
      resolve();
    };
    const timer = setTimeout(() => {
      log.warn(`Demo switch: ${activeRequests} request(s) still running after ${DRAIN_TIMEOUT_MS / 1000} s, switching anyway`);
      done();
    }, DRAIN_TIMEOUT_MS);
    drainWaiters.add(done);
  });
}

function requireInit(): { uri: string; store: DemoStateStore } {
  if (!realUri || !store) throw new Error("Demo mode is not initialised");
  return { uri: realUri, store };
}

/** Only the default connection is closed: mongoose.disconnect() would also close the DemoState connection. */
async function connectReal() {
  const { uri } = requireInit();
  await mongoose.connection.close();
  await mongoose.connect(uri);
  if (mongoose.connection.name !== mongoUriDbName(uri)) throw new Error("Connected to an unexpected database");
  setDemoModeFlag(false);
}

/** Connect the default connection to a fresh demo database, copy the users and generate the demo world. */
async function enterDemo(): Promise<Date> {
  const { uri, store: stateStore } = requireInit();
  const demoName = demoDbName(uri);
  await mongoose.connection.close();
  await mongoose.connect(uri, connectOptions(uri, demoName));
  const connection = mongoose.connection;
  // Never drop anything but the demo database
  if (connection.name !== demoName || demoName === stateStore.connection.name) throw new Error("Refusing to drop a database that is not the demo database");
  setDemoModeFlag(true);
  await connection.dropDatabase();
  // model.init() only runs once per process, so build the indexes of the fresh database explicitly
  await Promise.all(Object.values(mongoose.models).map((model) => model.createIndexes()));
  const users = await stateStore.connection.collection("users").find().toArray();
  if (users.length > 0) await connection.collection("users").insertMany(users);
  await clearDemoUploads();
  const now = new Date();
  await generator(now);
  log.info(`Demo database ${demoName} ready (${users.length} users copied)`);
  return now;
}

/** Drop the demo database and reconnect to the real one. */
async function leaveDemo() {
  const { uri } = requireInit();
  const demoName = demoDbName(uri);
  if (mongoose.connection.readyState === mongoose.ConnectionStates.connected && mongoose.connection.name === demoName) {
    await mongoose.connection.dropDatabase();
  }
  await connectReal();
  await clearDemoUploads();
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
  await drainRequests();

  if (enabled) {
    let startedAt: Date;
    try {
      startedAt = await enterDemo();
    } catch (error) {
      log.error("Could not switch to demo mode, back to the real database", error);
      await leaveDemo().catch((leaveError) => log.error("Could not reconnect to the real database", leaveError));
      await notifyListeners(false);
      throw error;
    }
    state = { enabled: true, enabledAt: new Date(), startedAt };
    await stateStore.write({ enabled: true, enabledAt: state.enabledAt, enabledBy: user?._id ? String(user._id) : null, startedAt });
    await notifyListeners(true);
    log.info("Demo mode on");
  } else {
    await leaveDemo();
    state = { enabled: false, enabledAt: null, startedAt: null };
    await stateStore.write({ enabled: false, enabledAt: null, enabledBy: null, startedAt: null });
    await notifyListeners(false);
    log.info("Demo mode off");
  }
  return getDemoState();
}
