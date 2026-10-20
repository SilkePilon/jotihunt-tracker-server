import { afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { NextFunction, Request, Response } from "express";
import express from "express";
import mongoose from "mongoose";
import { Area } from "../models/area.model";
import { createAccount, updateAccounts } from "../auth/user-store";
import { User } from "../models/user.model";
import { general, initAppConfig, resetAppConfig, setGeneral, setHuntTimesSource } from "../settings/app-config";
import {
  closeEditions,
  createEdition,
  editionHuntTimesSource,
  EditionRequestError,
  editionGate,
  getControlStore,
  getRegistry,
  initEditions,
  liveConnection,
  onEditionSwitch,
  readControlCollection,
  releaseSwitchWork,
  showEdition,
  shownEdition,
  SwitchBusyError,
  updateEditionHuntTimes,
} from "./database-switch";
import { dbConnectOptions, mongoUriDbName } from "./mongo-uri";
import { activeWorkCount, beginWork, currentGeneration, isArchiveShown, runTracked, skipWhenArchive } from "./work-tracking";

/**
 * A switch builds the indexes of every model registered in this process on the edition database (~0.15 s per model
 * on the test Mongo; ~5 s in a full run, where every model is imported), so bun's 5 s default is too tight.
 */
setDefaultTimeout(30_000);

describe("mongo uri helpers", () => {
  test("database name of a connection string", () => {
    expect(mongoUriDbName("mongodb://mongodb:27017/jotihunt")).toBe("jotihunt");
    expect(mongoUriDbName("mongodb://user:p%40ss@a:27017,b:27017/jotihunt?authSource=admin&replicaSet=rs0")).toBe("jotihunt");
    expect(mongoUriDbName("mongodb+srv://cluster.example.net/jotihunt?retryWrites=true")).toBe("jotihunt");
    expect(mongoUriDbName("mongodb://mongodb:27017")).toBe("test");
    expect(mongoUriDbName("mongodb://mongodb:27017/?retryWrites=true")).toBe("test");
    expect(() => mongoUriDbName("postgres://localhost/jotihunt")).toThrow();
  });

  test("connect options for another database on the same server", () => {
    expect(dbConnectOptions("mongodb://mongodb:27017/jotihunt", "jotihunt-2027")).toEqual({ dbName: "jotihunt-2027" });
    expect(dbConnectOptions("mongodb://u:p@mongodb:27017/jotihunt", "jotihunt-2027")).toEqual({ dbName: "jotihunt-2027", authSource: "jotihunt" });
    expect(dbConnectOptions("mongodb://u:p@mongodb:27017", "test-2027")).toEqual({ dbName: "test-2027", authSource: "admin" });
    expect(dbConnectOptions("mongodb://u:p@a:27017,b:27017/jotihunt?replicaSet=rs0&authSource=admin", "jotihunt-2027")).toEqual({ dbName: "jotihunt-2027" });
    expect(dbConnectOptions("mongodb+srv://u:p@cluster.example.net/jotihunt?retryWrites=true", "jotihunt-2027")).toEqual({ dbName: "jotihunt-2027" });
  });
});

/** A throwaway control database next to MONGO_URI_TEST per test, so this file does not collide with the other tests. */
const baseUri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
let name: string;
let uri: string;

const warnings: string[] = [];
const testLogger = { info() {}, warn: (message: string) => void warnings.push(message), error() {} };

beforeAll(async () => {
  if (mongoose.connection.readyState !== mongoose.ConnectionStates.disconnected) await mongoose.disconnect();
});

beforeEach(() => {
  name = `jh-editions-test-${Math.random().toString(36).slice(2, 8)}`;
  uri = baseUri.replace(/^(mongodb(?:\+srv)?:\/\/[^/?#]*)(?:\/[^?#]*)?/, `$1/${name}`);
  expect(mongoUriDbName(uri)).toBe(name);
  warnings.length = 0;
});

afterEach(async () => {
  await closeEditions();
  const admin = await mongoose.createConnection(baseUri).asPromise();
  for (const db of [name, `${name}-2027`, `${name}-2028`, `${name}-demo`]) await admin.useDb(db, { useCache: false }).dropDatabase();
  await admin.close();
});

async function countIn(dbName: string, collection: string) {
  const conn = await mongoose.createConnection(baseUri).asPromise();
  const count = await conn.useDb(dbName, { useCache: false }).collection(collection).countDocuments();
  await conn.close();
  return count;
}

describe("initEditions", () => {
  test("first boot registers 2026 on the control database, hunt times from app-config", async () => {
    const seed = await mongoose.createConnection(uri).asPromise();
    await seed.collection("settings").insertMany([
      { key: "app-config", general: { huntStart: "2026-10-17T08:00:00.000Z", huntEnd: "2026-10-18T10:00:00.000Z" } },
      { key: "demo", enabled: false },
    ]);
    await seed.useDb(`${name}-demo`, { useCache: false }).collection("areas").insertOne({ name: "Leftover" });
    await seed.close();
    const registry = await initEditions(uri, { now: () => new Date("2026-10-20T12:00:00Z") });
    expect(registry.liveYear).toBe(2026);
    expect(registry.shownYear).toBe(2026);
    expect(registry.editions[0]).toMatchObject({ year: 2026, dbName: name, huntStart: "2026-10-17T08:00:00.000Z", huntEnd: "2026-10-18T10:00:00.000Z" });
    expect(mongoose.connection.name).toBe(name);
    expect(isArchiveShown()).toBe(false);
    expect(await getControlStore().connection.collection("settings").findOne({ key: "demo" })).toBeNull();
    expect(await countIn(`${name}-demo`, "areas")).toBe(0);
    expect((await getControlStore().readRegistry())?.liveYear).toBe(2026);
  });

  test("first boot without hunt times in Beheer takes them from HUNT_START_TIME/HUNT_END_TIME (ISO, invalid skipped)", async () => {
    const registry = await initEditions(uri, { env: { HUNT_START_TIME: "2026-10-17T10:00+02:00", HUNT_END_TIME: "not a date" } });
    expect(registry.editions[0]).toMatchObject({ huntStart: "2026-10-17T08:00:00.000Z", huntEnd: null });
  });

  test("first boot prefers the Beheer hunt times over env", async () => {
    const seed = await mongoose.createConnection(uri).asPromise();
    await seed.collection("settings").insertOne({ key: "app-config", general: { huntStart: "2026-10-17T08:00:00.000Z" } });
    await seed.close();
    const registry = await initEditions(uri, { env: { HUNT_START_TIME: "2026-01-01T00:00:00Z", HUNT_END_TIME: "2026-10-18T10:00:00Z" } });
    expect(registry.editions[0]).toMatchObject({ huntStart: "2026-10-17T08:00:00.000Z", huntEnd: "2026-10-18T10:00:00.000Z" });
  });

  test("env hunt times are only used on the first boot", async () => {
    await initEditions(uri, { env: {} });
    await closeEditions();
    const registry = await initEditions(uri, { env: { HUNT_START_TIME: "2026-10-17T08:00:00Z" } });
    expect(registry.editions[0].huntStart).toBeNull();
  });

  test("a saved registry is used as is: the shown archive is connected again", async () => {
    await initEditions(uri);
    await createEdition();
    await showEdition(2026);
    await closeEditions();
    const registry = await initEditions(uri);
    expect(registry).toMatchObject({ liveYear: 2027, shownYear: 2026 });
    expect(mongoose.connection.name).toBe(name);
    expect(isArchiveShown()).toBe(true);
  });

  test("shownEdition: null before init, then the shown edition (a copy)", async () => {
    expect(shownEdition()).toBeNull();
    await initEditions(uri);
    await createEdition();
    expect(shownEdition()?.year).toBe(2027);
    await showEdition(2026);
    const shown = shownEdition()!;
    expect(shown).toMatchObject({ year: 2026, dbName: name });
    shown.huntStart = "mutated";
    expect(shownEdition()?.huntStart).toBeNull();
  });

  test("getRegistry returns a copy", async () => {
    await initEditions(uri);
    getRegistry().editions[0].huntStart = "mutated";
    expect(getRegistry().editions[0].huntStart).toBeNull();
  });

  test("readControlCollection reads the control database whichever edition is shown", async () => {
    await initEditions(uri);
    await mongoose.connection.collection("teams").insertOne({ name: "Alpha" });
    await createEdition();
    expect(await mongoose.connection.collection("teams").countDocuments()).toBe(0);
    expect((await readControlCollection<{ name: string }>("teams")).map((team) => team.name)).toEqual(["Alpha"]);
  });
});

describe("users master copy (the live edition's database)", () => {
  test("liveConnection: null before init, then the live edition's database whichever edition is shown", async () => {
    expect(liveConnection()).toBeNull();
    await initEditions(uri);
    expect(liveConnection()?.name).toBe(name);
    await createEdition();
    expect(liveConnection()?.name).toBe(`${name}-2027`);
    await showEdition(2026);
    expect(liveConnection()?.name).toBe(`${name}-2027`);
  });

  test("a user change written directly in the live 2027 database survives showing 2026 and back", async () => {
    await initEditions(uri);
    const { insertedId } = await mongoose.connection.collection("users").insertOne({ name: "silke", lastActiveAt: new Date("2026-10-20T10:00:00Z") });
    await createEdition();
    // e.g. phone pairing, device tokens, notification prefs: these write the User model directly
    await User.collection.updateOne({ _id: insertedId }, { $set: { name: "silke-2027", devices: ["phone"] } });
    await showEdition(2026);
    // The archive gets a copy of the live users
    expect((await User.collection.findOne({ _id: insertedId }))?.name).toBe("silke-2027");
    await showEdition(2027);
    expect(await User.collection.findOne({ _id: insertedId })).toMatchObject({ name: "silke-2027", devices: ["phone"] });
    // Also across a restart
    await closeEditions();
    await initEditions(uri);
    expect((await User.collection.findOne({ _id: insertedId }))?.name).toBe("silke-2027");
  });

  test("in the archive a user-store update also reaches the live edition's database", async () => {
    await initEditions(uri);
    await createEdition();
    const user = await createAccount({ name: "silke" });
    await showEdition(2026);
    expect(await updateAccounts({ _id: user._id }, { $set: { name: "silke-renamed" } })).toBe(true);
    expect((await mongoose.connection.collection("users").findOne({ _id: user._id }))?.name).toBe("silke-renamed");
    expect((await liveConnection()!.collection("users").findOne({ _id: user._id }))?.name).toBe("silke-renamed");
    await showEdition(2027);
    expect((await User.findById(user._id))?.name).toBe("silke-renamed");
  });

  test("booting with an archive shown copies the live users into it", async () => {
    await initEditions(uri);
    await createEdition();
    await mongoose.connection.collection("users").insertOne({ name: "new-in-2027" });
    await showEdition(2026);
    await closeEditions();
    await initEditions(uri);
    expect(mongoose.connection.name).toBe(name);
    expect((await mongoose.connection.collection("users").find().toArray()).map((user) => user.name)).toEqual(["new-in-2027"]);
  });

  test("a new edition copies users and push subscriptions from the previous live edition, not the control database", async () => {
    await initEditions(uri);
    await createEdition();
    await mongoose.connection.collection("users").insertOne({ name: "from-2027" });
    await mongoose.connection.collection("pushsubscriptions").insertOne({ endpoint: "https://push.example/2027" });
    await showEdition(2026);
    // Only in the archive's copy (the control database)
    await mongoose.connection.collection("users").insertOne({ name: "archive-only" });
    await createEdition();
    expect(mongoose.connection.name).toBe(`${name}-2028`);
    expect((await mongoose.connection.collection("users").find().toArray()).map((user) => user.name)).toEqual(["from-2027"]);
    expect(await mongoose.connection.collection("pushsubscriptions").countDocuments()).toBe(1);
  });
});

describe("edition hunt times source", () => {
  afterEach(() => resetAppConfig());

  test("app-config reads and writes the shown edition's hunt times", async () => {
    await initEditions(uri);
    await initAppConfig(getControlStore().connection, {});
    setHuntTimesSource(editionHuntTimesSource());
    await setGeneral({ huntStart: "2026-10-17T08:00:00Z" }, null);
    expect(getRegistry().editions[0].huntStart).toBe("2026-10-17T08:00:00.000Z");
    expect(general("huntStart")).toEqual({ value: "2026-10-17T08:00:00.000Z", source: "db" });
  });

  test("in an archive a hunt-time write fails with 423 and saves nothing; other general settings still save", async () => {
    await initEditions(uri);
    await createEdition();
    await showEdition(2026);
    await initAppConfig(getControlStore().connection, {});
    setHuntTimesSource(editionHuntTimesSource());
    const error = await setGeneral({ huntStart: "2026-10-17T08:00:00Z", groupName: "Scouting X" }, null).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 423, message: "Archief is alleen-lezen" });
    expect(getRegistry().editions.every((edition) => edition.huntStart === null)).toBe(true);
    expect((await getControlStore().readRegistry())?.editions.every((edition) => edition.huntStart === null)).toBe(true);
    const appConfig = () => getControlStore().connection.collection("settings").findOne({ key: "app-config" });
    expect((await appConfig())?.general?.groupName).toBeUndefined();
    await setGeneral({ groupName: "Scouting X" }, null);
    expect((await appConfig())?.general?.groupName).toBe("Scouting X");
  });
});

describe("createEdition + showEdition", () => {
  test("new edition gets its own database with users copied; old one becomes a viewable archive", async () => {
    await initEditions(uri, { now: () => new Date("2026-10-20T12:00:00Z") });
    await mongoose.connection.collection("users").insertOne({ name: "silke" });
    await mongoose.connection.collection("pushsubscriptions").insertOne({ endpoint: "https://push.example/1" });
    await mongoose.connection.collection("hunts").insertOne({ code: "x" });
    const switches: number[] = [];
    onEditionSwitch((r) => void switches.push(r.shownYear));

    const created = await createEdition();
    expect(created.liveYear).toBe(2027);
    expect(created.editions[1]).toMatchObject({ year: 2027, dbName: `${name}-2027`, huntStart: null, huntEnd: null });
    expect(mongoose.connection.name).toBe(`${name}-2027`);
    expect(isArchiveShown()).toBe(false);
    expect(await mongoose.connection.collection("users").countDocuments()).toBe(1);
    expect(await mongoose.connection.collection("pushsubscriptions").countDocuments()).toBe(1);
    expect(await mongoose.connection.collection("hunts").countDocuments()).toBe(0);

    const shown = await showEdition(2026);
    expect(shown.shownYear).toBe(2026);
    expect(isArchiveShown()).toBe(true);
    expect(mongoose.connection.name).toBe(name);
    expect(await mongoose.connection.collection("hunts").countDocuments()).toBe(1);
    expect(switches).toEqual([2027, 2026]);
    expect((await getControlStore().readRegistry())?.shownYear).toBe(2026);
  });

  test("night areas are copied into the new edition", async () => {
    await initEditions(uri);
    await mongoose.connection.collection("settings").insertOne({ key: "night-areas", enabled: true, areas: [{ id: "a", name: "Posbank", kind: "closed", polygon: [] }] });
    await createEdition();
    const copied = await mongoose.connection.collection("settings").findOne({ key: "night-areas" });
    expect(copied?.areas).toHaveLength(1);
  });

  test("showing the shown edition is a no-op", async () => {
    await initEditions(uri);
    let calls = 0;
    onEditionSwitch(() => void calls++);
    await showEdition(2026);
    expect(calls).toBe(0);
  });

  test("showing an unknown edition is refused with 404", async () => {
    await initEditions(uri);
    const error = await showEdition(2030).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EditionRequestError);
    expect(error).toMatchObject({ status: 404, message: "Die editie bestaat niet" });
  });

  test("busy work refuses the switch with SwitchBusyError and nothing changes", async () => {
    await initEditions(uri, { drainTimeoutMs: 100 });
    await createEdition();
    const finish = beginWork();
    await expect(showEdition(2026)).rejects.toBeInstanceOf(SwitchBusyError);
    finish();
    expect(getRegistry().shownYear).toBe(2027);
    expect(mongoose.connection.name).toBe(`${name}-2027`);
    expect((await getControlStore().readRegistry())?.shownYear).toBe(2027);
  });

  test("showing an archive during the live hunt is refused with 409", async () => {
    await initEditions(uri, { now: () => new Date("2027-10-16T20:00:00Z") });
    await createEdition();
    await updateEditionHuntTimes(2027, { huntStart: "2027-10-16T08:00:00.000Z", huntEnd: "2027-10-17T10:00:00.000Z" });
    await expect(showEdition(2026)).rejects.toMatchObject({ status: 409, message: "Archief kan niet tijdens de hunt" });
    await expect(createEdition()).rejects.toMatchObject({ status: 409 });
    expect(mongoose.connection.name).toBe(`${name}-2027`);
  });

  test("hunt times saved while a switch drains survive the switch", async () => {
    await initEditions(uri, { drainTimeoutMs: 5_000 });
    const finish = beginWork(); // the request that edits the hunt times
    const switched = createEdition();
    await Bun.sleep(50);
    await updateEditionHuntTimes(2026, { huntStart: "2026-10-17T08:00:00.000Z" });
    finish();
    await switched;
    expect(getRegistry().editions[0].huntStart).toBe("2026-10-17T08:00:00.000Z");
    expect((await getControlStore().readRegistry())?.editions[0].huntStart).toBe("2026-10-17T08:00:00.000Z");
  });

  test("updateEditionHuntTimes persists, 404 for an unknown edition", async () => {
    await initEditions(uri);
    const updated = await updateEditionHuntTimes(2026, { huntEnd: "2026-10-18T10:00:00.000Z" });
    expect(updated.editions[0].huntEnd).toBe("2026-10-18T10:00:00.000Z");
    expect((await getControlStore().readRegistry())?.editions[0].huntEnd).toBe("2026-10-18T10:00:00.000Z");
    await expect(updateEditionHuntTimes(2031, { huntEnd: null })).rejects.toMatchObject({ status: 404 });
  });

  test("the jotihunt.nl cron guard skips runs only while an archive is shown", async () => {
    await initEditions(uri);
    const messages: string[] = [];
    expect(skipWhenArchive("jotihunt-areas", (message) => messages.push(message))).toBe(false);
    await createEdition();
    expect(skipWhenArchive("jotihunt-areas", (message) => messages.push(message))).toBe(false);
    await showEdition(2026);
    expect(skipWhenArchive("jotihunt-areas", (message) => messages.push(message))).toBe(true);
    expect(messages).toEqual(["(CRON) Skipping jotihunt-areas: archive is shown"]);
  });
});

function fakeRes() {
  return new EventEmitter() as unknown as Response;
}

/** A fake response with end() that emits "finish" like a real one */
function fakeResWithEnd() {
  const res = new EventEmitter() as EventEmitter & { end: () => void; writableFinished: boolean };
  res.writableFinished = false;
  res.end = () => {
    res.writableFinished = true;
    res.emit("finish");
    res.emit("close");
  };
  return res;
}

describe("the edition gate and draining", () => {
  beforeEach(async () => {
    await initEditions(uri, { drainTimeoutMs: 1_000, abandonedRequestMs: 300, logger: testLogger });
  });

  test("the gate makes a request wait for a running switch", async () => {
    const busy = beginWork(); // keeps the switch draining
    const switched = createEdition();
    await Bun.sleep(50);
    let passed = false;
    const next: NextFunction = () => {
      passed = true;
    };
    const waiting = fakeRes();
    editionGate({} as Request, waiting, next);
    await Bun.sleep(50);
    expect(passed).toBe(false);

    busy();
    await switched;
    await Bun.sleep(0);
    expect(passed).toBe(true);
    expect(mongoose.connection.name).toBe(`${name}-2027`);
    (waiting as unknown as EventEmitter).emit("finish");

    // A counted request in flight delays the next switch until it finishes
    const res = fakeRes();
    editionGate({} as Request, res, () => {});
    let shown = false;
    const showing = showEdition(2026).then(() => (shown = true));
    await Bun.sleep(50);
    expect(shown).toBe(false);
    (res as unknown as EventEmitter).emit("finish");
    await showing;
    expect(isArchiveShown()).toBe(true);
  });

  test("a request the client aborted still delays a switch until its handler responds", async () => {
    const res = fakeResWithEnd();
    editionGate({ method: "POST", originalUrl: "/admin/users" } as Request, res as unknown as Response, () => {});
    const counted = activeWorkCount();
    res.emit("close"); // client gone, handler still working
    expect(activeWorkCount()).toBe(counted);
    let created = false;
    const creating = createEdition().then(() => (created = true));
    await Bun.sleep(100);
    expect(created).toBe(false);
    res.end(); // the handler responds (into the void)
    await creating;
    expect(getRegistry().liveYear).toBe(2027);
  });

  test("an aborted request whose handler never responds stops counting after a while (logged)", async () => {
    const res = fakeResWithEnd();
    editionGate({ method: "PUT", originalUrl: "/hangs" } as Request, res as unknown as Response, () => {});
    res.emit("close");
    const started = Date.now();
    await createEdition();
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(warnings).toEqual(["PUT /hangs (client gone) still running after 0.3 s; no longer delays a switch"]);
    res.end(); // a late response does not count twice
    await showEdition(2026);
    expect(isArchiveShown()).toBe(true);
  });

  test("an aborted GET or HEAD stops counting right away: reads can't write into the wrong database", async () => {
    for (const method of ["GET", "HEAD"]) {
      const before = activeWorkCount();
      const res = fakeResWithEnd();
      editionGate({ method, originalUrl: "/hunt-reports/x/photo" } as Request, res as unknown as Response, () => {});
      expect(activeWorkCount()).toBe(before + 1);
      res.emit("close"); // client gone, handler (e.g. sendFile) still busy
      expect(activeWorkCount()).toBe(before);
      res.end(); // a late response does not count twice
      expect(activeWorkCount()).toBe(before);
    }
    await createEdition();
    expect(warnings).toEqual([]);
  });

  test("over real HTTP: an aborted request is counted until the handler finishes", async () => {
    let respond!: () => void;
    const handlerDone = new Promise<void>((resolve) => (respond = resolve));
    let handlerStarted!: () => void;
    const started = new Promise<void>((resolve) => (handlerStarted = resolve));
    const app = express();
    app.use(editionGate);
    app.post("/slow", async (_req, res) => {
      handlerStarted();
      await handlerDone;
      res.json({ ok: true });
    });
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const before = activeWorkCount();
      const controller = new AbortController();
      const request = fetch(`http://127.0.0.1:${port}/slow`, { method: "POST", signal: controller.signal }).catch(() => null);
      await started;
      controller.abort();
      await request;
      await Bun.sleep(50);
      expect(activeWorkCount()).toBe(before + 1);
      respond();
      await Bun.sleep(50);
      expect(activeWorkCount()).toBe(before);
    } finally {
      server.close();
    }
  });

  test("a streaming response that released its count (the Intel chat) does not hold up a switch", async () => {
    let endStream!: () => void;
    const streamEnd = new Promise<void>((resolve) => (endStream = resolve));
    const app = express();
    app.use(editionGate);
    app.post("/stream", async (_req, res) => {
      releaseSwitchWork(res);
      res.write("first chunk");
      await streamEnd;
      res.end();
    });
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const before = activeWorkCount();
      const res = await fetch(`http://127.0.0.1:${port}/stream`, { method: "POST" });
      const reader = res.body!.getReader();
      await reader.read();
      expect(activeWorkCount()).toBe(before);
      await createEdition();
      expect(getRegistry().liveYear).toBe(2027);
      endStream();
      while (!(await reader.read()).done);
      expect(activeWorkCount()).toBe(before);
    } finally {
      endStream();
      server.close();
    }
  });

  test("a slow tracked job delays the switch; its writes stay in the edition it started in", async () => {
    await createEdition();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const job = runTracked(async () => {
      await gate;
      await Area.create({ name: "SlowJob", status: "green", updatedAt: new Date() });
      return "done";
    });
    let shown = false;
    const showing = showEdition(2026).then(() => (shown = true));
    await Bun.sleep(100);
    expect(shown).toBe(false);
    expect(mongoose.connection.name).toBe(`${name}-2027`);
    release();
    expect(await job).toBe("done");
    await showing;
    expect(mongoose.connection.name).toBe(name);
    expect(await Area.countDocuments({ name: "SlowJob" })).toBe(0);
    expect(await countIn(`${name}-2027`, "areas")).toBe(1);
  });

  test("a tracked job started while a switch runs is skipped", async () => {
    const busy = beginWork();
    const switched = createEdition();
    await Bun.sleep(50);
    let ran = false;
    expect(
      await runTracked(async () => {
        ran = true;
        return 1;
      }),
    ).toBeUndefined();
    expect(ran).toBe(false);
    busy();
    await switched;
    expect(await runTracked(async () => 2)).toBe(2);
  });

  test("the generation check prevents a write after a switch", async () => {
    const generation = currentGeneration();
    await createEdition();
    expect(currentGeneration()).not.toBe(generation);
    let wrote = false;
    const result = await runTracked(
      async () => {
        wrote = true;
        await Area.create({ name: "Stale", status: "green", updatedAt: new Date() });
      },
      { generation },
    );
    expect(result).toBeUndefined();
    expect(wrote).toBe(false);
    await showEdition(2026);
    expect(await Area.countDocuments({ name: "Stale" })).toBe(0);
  });

  test("a switch is refused (409) when work keeps running past the drain timeout; nothing changes", async () => {
    let release!: () => void;
    const job = runTracked(() => new Promise<void>((resolve) => (release = resolve)));
    const error = await createEdition().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SwitchBusyError);
    expect((error as SwitchBusyError).status).toBe(409);
    expect((error as Error).message).toBe("Er lopen nog taken; probeer het zo opnieuw.");
    expect(mongoose.connection.name).toBe(name);
    expect(getRegistry()).toMatchObject({ liveYear: 2026, shownYear: 2026 });
    expect(getRegistry().editions).toHaveLength(1);
    // Tracked work runs again once the refused switch is over
    expect(await runTracked(async () => 3)).toBe(3);
    release();
    await job;
  });
});
