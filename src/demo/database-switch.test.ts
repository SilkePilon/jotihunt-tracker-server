import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { Area } from "../models/area.model";
import { User } from "../models/user.model";
import {
  closeDemoMode,
  demoConnectOptions,
  demoDbName,
  demoGate,
  DemoSwitchBusyError,
  getDemoState,
  initDemoMode,
  mongoUriDbName,
  releaseDemoWork,
  setDemoWorldGenerator,
  switchDemoMode,
} from "./database-switch";
import express from "express";
import { activeWorkCount, currentGeneration, isDemoMode, runTracked, skipInDemoMode } from "./demo-mode";

describe("demo database name", () => {
  test("appends -demo to the database name", () => {
    expect(mongoUriDbName("mongodb://mongodb:27017/jotihunt")).toBe("jotihunt");
    expect(demoDbName("mongodb://mongodb:27017/jotihunt")).toBe("jotihunt-demo");
  });

  test("ignores query strings, credentials and multiple hosts", () => {
    expect(demoDbName("mongodb://user:p%40ss@a:27017,b:27017/jotihunt?authSource=admin&replicaSet=rs0")).toBe("jotihunt-demo");
    expect(demoDbName("mongodb+srv://cluster.example.net/jotihunt?retryWrites=true")).toBe("jotihunt-demo");
  });

  test("uses the driver default when the URI has no database", () => {
    expect(demoDbName("mongodb://mongodb:27017")).toBe("test-demo");
    expect(demoDbName("mongodb://mongodb:27017/?retryWrites=true")).toBe("test-demo");
  });

  test("refuses invalid connection strings", () => {
    expect(() => demoDbName("postgres://localhost/jotihunt")).toThrow();
  });
});

describe("demo connect options", () => {
  test("without credentials only the database name is set", () => {
    expect(demoConnectOptions("mongodb://mongodb:27017/jotihunt", "jotihunt-demo")).toEqual({ dbName: "jotihunt-demo" });
  });

  test("with credentials keeps authenticating against the real database (or admin)", () => {
    expect(demoConnectOptions("mongodb://u:p@mongodb:27017/jotihunt", "jotihunt-demo")).toEqual({ dbName: "jotihunt-demo", authSource: "jotihunt" });
    expect(demoConnectOptions("mongodb://u:p@mongodb:27017", "test-demo")).toEqual({ dbName: "test-demo", authSource: "admin" });
  });

  test("an explicit authSource in the URI is left to the driver", () => {
    expect(demoConnectOptions("mongodb://u:p@a:27017,b:27017/jotihunt?replicaSet=rs0&authSource=admin", "jotihunt-demo")).toEqual({ dbName: "jotihunt-demo" });
  });

  test("mongodb+srv URIs are left to the driver (authSource from DNS)", () => {
    expect(demoConnectOptions("mongodb+srv://u:p@cluster.example.net/jotihunt?retryWrites=true", "jotihunt-demo")).toEqual({ dbName: "jotihunt-demo" });
  });
});

/** A test-only "real" database next to MONGO_URI_TEST, so this file does not collide with the other tests. */
const baseUri = process.env.MONGO_URI_TEST ?? "mongodb://localhost:27017/jotihunt-test";
const realName = `${mongoUriDbName(baseUri)}-demoswitch`;
const realUri = baseUri.replace(/^(mongodb(?:\+srv)?:\/\/[^/?#]*)(?:\/[^?#]*)?/, `$1/${realName}`);
const demoName = demoDbName(realUri);

async function dropTestDatabases() {
  const admin = await mongoose.createConnection(baseUri).asPromise();
  await admin.useDb(realName, { useCache: false }).dropDatabase();
  await admin.useDb(demoName, { useCache: false }).dropDatabase();
  await admin.close();
}

async function countIn(dbName: string, collection: string) {
  const conn = await mongoose.createConnection(baseUri).asPromise();
  const count = await conn.useDb(dbName, { useCache: false }).collection(collection).countDocuments();
  await conn.close();
  return count;
}

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

const warnings: string[] = [];
const testLogger = { info() {}, warn: (message: string) => void warnings.push(message), error() {} };

describe("switching between the real and the demo database", () => {
  beforeAll(async () => {
    expect(realName).not.toBe("jotihunt");
    if (mongoose.connection.readyState !== mongoose.ConnectionStates.disconnected) await mongoose.disconnect();
    await dropTestDatabases();
    await initDemoMode(realUri, { drainTimeoutMs: 1_000, abandonedRequestMs: 300, logger: testLogger });
    expect(mongoose.connection.name).toBe(realName);
  });

  afterAll(async () => {
    await closeDemoMode();
    await dropTestDatabases();
  });

  test("real data survives an on/off cycle, users are copied and demo data is gone after off", async () => {
    const user = await User.create({ name: "HQ", admin: true });
    await Area.create({ name: "Alpha", status: "green", updatedAt: new Date() });
    let generatedAt: Date | null = null;
    setDemoWorldGenerator(async (now) => {
      generatedAt = now;
      await Area.create({ name: "Demo", status: "red", updatedAt: now });
    });

    const on = await switchDemoMode(true, user);
    expect(on.enabled).toBe(true);
    expect(on.startedAt).toEqual(generatedAt!);
    expect(isDemoMode()).toBe(true);
    expect(mongoose.connection.name).toBe(demoName);
    const copied = await User.findById(user._id).lean();
    expect(copied?.name).toBe("HQ");
    expect((await Area.find().lean()).map((area) => area.name)).toEqual(["Demo"]);

    // Switching to the current state is a no-op
    expect((await switchDemoMode(true, user)).startedAt).toEqual(on.startedAt);

    const off = await switchDemoMode(false, user);
    expect(off).toEqual({ enabled: false, enabledAt: null, startedAt: null });
    expect(isDemoMode()).toBe(false);
    expect(mongoose.connection.name).toBe(realName);
    expect((await Area.find().lean()).map((area) => area.name)).toEqual(["Alpha"]);
    expect(await User.countDocuments()).toBe(1);
    expect(await countIn(demoName, "areas")).toBe(0);
    expect(await countIn(demoName, "users")).toBe(0);
    expect(await countIn(realName, "settings")).toBe(1);
  });

  test("the jotihunt.nl cron guard skips runs only in demo mode", async () => {
    const messages: string[] = [];
    expect(skipInDemoMode("jotihunt-areas", (message) => messages.push(message))).toBe(false);
    setDemoWorldGenerator(async () => {});
    await switchDemoMode(true);
    expect(skipInDemoMode("jotihunt-areas", (message) => messages.push(message))).toBe(true);
    expect(messages).toEqual(["(CRON) Skipping jotihunt-areas: demo mode is on"]);
    await switchDemoMode(false);
    expect(getDemoState().enabled).toBe(false);
  });

  test("the gate makes a request wait for a running switch", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    setDemoWorldGenerator(() => blocked);

    const switched = switchDemoMode(true);
    await Bun.sleep(50);
    let passed = false;
    const next: NextFunction = () => {
      passed = true;
    };
    const waiting = fakeRes();
    demoGate({} as Request, waiting, next);
    await Bun.sleep(50);
    expect(passed).toBe(false);

    release();
    await switched;
    await Bun.sleep(0);
    expect(passed).toBe(true);
    expect(isDemoMode()).toBe(true);
    (waiting as unknown as EventEmitter).emit("finish");

    // A counted request in flight delays the next switch until it finishes
    const res = fakeRes();
    demoGate({} as Request, res, () => {});
    let off = false;
    const switchingOff = switchDemoMode(false).then(() => (off = true));
    await Bun.sleep(50);
    expect(off).toBe(false);
    (res as unknown as EventEmitter).emit("finish");
    await switchingOff;
    expect(isDemoMode()).toBe(false);
  });

  test("a request the client aborted still delays a switch until its handler responds", async () => {
    setDemoWorldGenerator(async () => {});
    const res = fakeResWithEnd();
    demoGate({ method: "POST", originalUrl: "/admin/users" } as Request, res as unknown as Response, () => {});
    const counted = activeWorkCount();
    res.emit("close"); // client gone, handler still working
    expect(activeWorkCount()).toBe(counted);
    let on = false;
    const switchingOn = switchDemoMode(true).then(() => (on = true));
    await Bun.sleep(100);
    expect(on).toBe(false);
    res.end(); // the handler responds (into the void)
    await switchingOn;
    expect(isDemoMode()).toBe(true);
    await switchDemoMode(false);
  });

  test("an aborted request whose handler never responds stops counting after a while (logged)", async () => {
    setDemoWorldGenerator(async () => {});
    warnings.length = 0;
    const res = fakeResWithEnd();
    demoGate({ method: "PUT", originalUrl: "/hangs" } as Request, res as unknown as Response, () => {});
    res.emit("close");
    const started = Date.now();
    await switchDemoMode(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(warnings).toEqual(["PUT /hangs (client gone) still running after 0.3 s; no longer delays a demo switch"]);
    res.end(); // a late response does not count twice
    await switchDemoMode(false);
    expect(isDemoMode()).toBe(false);
  });

  test("an aborted GET or HEAD stops counting right away: reads can't write into the wrong database", async () => {
    setDemoWorldGenerator(async () => {});
    warnings.length = 0;
    for (const method of ["GET", "HEAD"]) {
      const before = activeWorkCount();
      const res = fakeResWithEnd();
      demoGate({ method, originalUrl: "/hunt-reports/x/photo" } as Request, res as unknown as Response, () => {});
      expect(activeWorkCount()).toBe(before + 1);
      res.emit("close"); // client gone, handler (e.g. sendFile) still busy
      expect(activeWorkCount()).toBe(before);
      res.end(); // a late response does not count twice
      expect(activeWorkCount()).toBe(before);
    }
    await switchDemoMode(true);
    expect(warnings).toEqual([]);
    await switchDemoMode(false);
  });

  test("over real HTTP: an aborted request is counted until the handler finishes", async () => {
    let respond!: () => void;
    const handlerDone = new Promise<void>((resolve) => (respond = resolve));
    let handlerStarted!: () => void;
    const started = new Promise<void>((resolve) => (handlerStarted = resolve));
    const app = express();
    app.use(demoGate);
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
    app.use(demoGate);
    app.post("/stream", async (_req, res) => {
      releaseDemoWork(res);
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
      setDemoWorldGenerator(async () => {});
      await switchDemoMode(true);
      expect(isDemoMode()).toBe(true);
      endStream();
      while (!(await reader.read()).done);
      expect(activeWorkCount()).toBe(before);
      await switchDemoMode(false);
    } finally {
      endStream();
      server.close();
    }
  });

  test("a slow tracked job started in demo mode delays switch-off; its writes stay in the demo database", async () => {
    setDemoWorldGenerator(async () => {});
    await switchDemoMode(true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const job = runTracked(async () => {
      await gate;
      await Area.create({ name: "SlowDemoJob", status: "green", updatedAt: new Date() });
      return "done";
    });
    let off = false;
    const switchingOff = switchDemoMode(false).then(() => (off = true));
    await Bun.sleep(100);
    expect(off).toBe(false);
    expect(isDemoMode()).toBe(true);
    release();
    expect(await job).toBe("done");
    await switchingOff;
    expect(isDemoMode()).toBe(false);
    expect(await Area.countDocuments({ name: "SlowDemoJob" })).toBe(0);
    expect(await countIn(demoName, "areas")).toBe(0);
  });

  test("a tracked job started while a switch runs is skipped", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    setDemoWorldGenerator(() => blocked);
    const switched = switchDemoMode(true);
    await Bun.sleep(50);
    let ran = false;
    expect(
      await runTracked(async () => {
        ran = true;
        return 1;
      }),
    ).toBeUndefined();
    expect(ran).toBe(false);
    release();
    await switched;
    expect(await runTracked(async () => 2)).toBe(2);
    await switchDemoMode(false);
  });

  test("the generation check prevents a write after a switch", async () => {
    const generation = currentGeneration();
    setDemoWorldGenerator(async () => {});
    await switchDemoMode(true);
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
    await switchDemoMode(false);
    expect(await Area.countDocuments({ name: "Stale" })).toBe(0);
  });

  test("a switch is refused (409) when work keeps running past the drain timeout; nothing changes", async () => {
    let release!: () => void;
    const job = runTracked(() => new Promise<void>((resolve) => (release = resolve)));
    const error = await switchDemoMode(true).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DemoSwitchBusyError);
    expect((error as DemoSwitchBusyError).status).toBe(409);
    expect((error as Error).message).toBe("Er lopen nog taken; probeer het zo opnieuw.");
    expect(isDemoMode()).toBe(false);
    expect(mongoose.connection.name).toBe(realName);
    expect(getDemoState().enabled).toBe(false);
    // Tracked work runs again once the refused switch is over
    expect(await runTracked(async () => 3)).toBe(3);
    release();
    await job;
  });

  test("a leftover demo database is dropped at startup", async () => {
    await closeDemoMode();
    const conn = await mongoose.createConnection(baseUri).asPromise();
    await conn.useDb(demoName, { useCache: false }).collection("areas").insertOne({ name: "Leftover" });
    await conn.close();
    expect(await countIn(demoName, "areas")).toBe(1);
    await initDemoMode(realUri, { drainTimeoutMs: 1_000 });
    expect(await countIn(demoName, "areas")).toBe(0);
    expect(mongoose.connection.name).toBe(realName);
  });
});
