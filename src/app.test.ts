import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { Article } from "./models/article.model";
import { HintCell, HintCellStatus } from "./models/hint-cell.model";
import { User } from "./models/user.model";
import { sessions } from "./auth/models";
import { clearTestDb, connectTestDb, disconnectTestDb } from "./test/db";
import { tokenFor, withSession } from "./test/auth";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";
const { app, isQuietRequest } = await import("./app");

let server: Server;
let base: string;

beforeAll(async () => {
  await connectTestDb();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(clearTestDb);
afterAll(async () => {
  server.close();
  await disconnectTestDb();
});

const sign = (payload: object, options: jwt.SignOptions = { expiresIn: "36h" }) => jwt.sign(payload, process.env.JWT_SECRET!, options);

async function createUser(fields: { admin?: boolean; name?: string } = {}) {
  return withSession(await User.create({ name: fields.name ?? "Test", admin: fields.admin ?? false }));
}

function request(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (init.json !== undefined) headers.set("Content-Type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

describe("auth middleware", () => {
  test("a valid token passes", async () => {
    const user = await createUser();
    expect((await request("/markers", { token: tokenFor(user) })).status).toBe(200);
  });

  test("missing, invalid, expired, old-style or wrongly shaped tokens get 401", async () => {
    const user = await createUser();
    const sid = String((await sessions().findOne({ user: user._id }).lean())!._id);
    expect((await request("/markers")).status).toBe(401);
    expect((await request("/markers", { token: "nonsense" })).status).toBe(401);
    expect((await request("/markers", { token: sign({ sid }, { expiresIn: -10 }) })).status).toBe(401);
    // Password-era token: only an _id, no session
    expect((await request("/markers", { token: sign({ _id: String(user._id) }) })).status).toBe(401);
    expect((await request("/markers", { token: sign({ sid: "not-an-object-id" }) })).status).toBe(401);
    expect((await request("/markers", { token: sign({ sid: { $ne: null } }) })).status).toBe(401);
    expect((await request("/markers", { token: sign({ sid: String(new mongoose.Types.ObjectId()) }) })).status).toBe(401);
  });

  test("a revoked or expired session gets 401; a deleted user too", async () => {
    const user = await createUser();
    const token = tokenFor(user);
    await sessions().updateMany({ user: user._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request("/markers", { token })).status).toBe(401);
    const other = await createUser();
    await sessions().deleteMany({ user: other._id });
    expect((await request("/markers", { token: tokenFor(other) })).status).toBe(401);
    const gone = await createUser();
    await User.deleteOne({ _id: gone._id });
    expect((await request("/markers", { token: tokenFor(gone) })).status).toBe(401);
  });

  test("a database error is a 503, not a 401 (clients sign out on 401)", async () => {
    const user = await createUser();
    const error = Object.assign(new Error("connection refused"), { name: "MongoNetworkError" });
    const spy = spyOn(User, "findById").mockImplementation((() => Promise.reject(error)) as never);
    try {
      const res = await request("/markers", { token: tokenFor(user) });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ message: "Database niet bereikbaar" });
    } finally {
      spy.mockRestore();
    }
  });

  test("other errors are a 500, not a 401", async () => {
    const user = await createUser();
    const spy = spyOn(User, "findById").mockImplementation((() => Promise.reject(new Error("bug"))) as never);
    try {
      expect((await request("/markers", { token: tokenFor(user) })).status).toBe(500);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("admin user management", () => {
  test("the last admin can not delete or demote themselves", async () => {
    const admin = await createUser({ admin: true });
    const token = tokenFor(admin);
    const del = await request(`/admin/users/${admin._id}`, { method: "DELETE", token });
    expect(del.status).toBe(409);
    expect(((await del.json()) as { message: string }).message).toBe("Er moet minstens één admin overblijven.");
    expect((await request(`/admin/users/${admin._id}`, { method: "PUT", token, json: { admin: false } })).status).toBe(409);
    expect((await User.findById(admin._id))!.admin).toBe(true);
  });

  test("with another admin left, demoting and deleting admins works", async () => {
    const a = await createUser({ admin: true });
    const b = await createUser({ admin: true });
    expect((await request(`/admin/users/${b._id}`, { method: "PUT", token: tokenFor(a), json: { admin: false } })).status).toBe(200);
    const c = await createUser({ admin: true });
    expect((await request(`/admin/users/${a._id}`, { method: "DELETE", token: tokenFor(a) })).status).toBe(200);
    expect(await User.countDocuments({ admin: true })).toBe(1);
    expect((await User.findById(c._id))!.admin).toBe(true);
  });

  test("two admins demoting/deleting each other at the same time leave one admin", async () => {
    for (let round = 0; round < 5; round++) {
      await clearTestDb();
      const a = await createUser({ admin: true });
      const b = await createUser({ admin: true });
      const results = await Promise.all([
        request(`/admin/users/${b._id}`, { method: "PUT", token: tokenFor(a), json: { admin: false } }),
        request(`/admin/users/${a._id}`, { method: round % 2 ? "DELETE" : "PUT", token: tokenFor(b), json: { admin: false } }),
      ]);
      expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
      expect(await User.countDocuments({ admin: true })).toBe(1);
    }
  });

});

describe("intel: assignments and read state", () => {
  const makeArticle = (id: number, type: string) => Article.create({ id, title: `Artikel ${id}`, type, publishAt: new Date("2026-10-17T12:00:00Z"), content: "<div>tekst</div>" });

  test("without a token every route answers 401", async () => {
    const calls: [string, RequestInit & { json?: unknown }][] = [
      ["/assignments", {}],
      ["/assignments/members", {}],
      ["/articles/read", {}],
    ];
    for (const [path, init] of calls) expect([path, (await request(path, init)).status]).toEqual([path, 401]);
    // The old hints page's presence heartbeat is gone
    expect((await request("/presence", { method: "POST", token: tokenFor(await createUser()), json: { itemId: 5 } })).status).toBe(404);
  });

  test("an assignment write without a body, and an owner write without owner, are a 400", async () => {
    const token = tokenFor(await createUser());
    await makeArticle(7, "assignment");
    for (const path of ["/assignments/7/status", "/assignments/7/owner", "/assignments/7/notes"]) {
      expect([path, (await request(path, { method: "POST", token })).status]).toEqual([path, 400]);
    }
    expect((await request("/assignments/7/owner", { method: "POST", token, json: {} })).status).toBe(400);
    expect((await request("/assignments/7/owner", { method: "POST", token, json: { overwrite: true } })).status).toBe(400);
    expect((await request("/assignments/7/owner", { method: "POST", token, json: { owner: "geen-id" } })).status).toBe(400);
    expect(await request("/assignments", { token }).then((res) => res.json())).toEqual([]);
  });

  test("the owner can be set to a user and to nobody (null)", async () => {
    const user = await createUser({ name: "Sanne" });
    const token = tokenFor(user);
    await makeArticle(7, "assignment");
    const given = await request("/assignments/7/owner", { method: "POST", token, json: { owner: String(user._id) } });
    expect(given.status).toBe(200);
    expect(((await given.json()) as { owner: { name: string } }).owner.name).toBe("Sanne");
    const taken = await request("/assignments/7/owner", { method: "POST", token, json: { owner: null } });
    expect(taken.status).toBe(200);
    expect(((await taken.json()) as { owner?: unknown }).owner ?? null).toBeNull();
  });

  test("anyone may change a status someone else set; the last write wins and records who", async () => {
    const [a, b] = [await createUser({ name: "Sanne" }), await createUser({ name: "Daan" })];
    await makeArticle(7, "assignment");
    expect((await request("/assignments/7/status", { method: "POST", token: tokenFor(a), json: { status: "busy" } })).status).toBe(200);
    const changed = await request("/assignments/7/status", { method: "POST", token: tokenFor(b), json: { status: "skipped" } });
    expect(changed.status).toBe(200);
    expect((await changed.json()) as { status: string; statusBy: { name: string } }).toMatchObject({ status: "skipped", statusBy: { name: "Daan" } });
  });

  test("anyone may take over an owned assignment", async () => {
    const [a, b] = [await createUser({ name: "Sanne" }), await createUser({ name: "Daan" })];
    await makeArticle(7, "assignment");
    await request("/assignments/7/owner", { method: "POST", token: tokenFor(a), json: { owner: String(a._id) } });
    const taken = await request("/assignments/7/owner", { method: "POST", token: tokenFor(b), json: { owner: String(b._id) } });
    expect(taken.status).toBe(200);
    expect(((await taken.json()) as { owner: { name: string } }).owner.name).toBe("Daan");
  });

  test("marking an article read shows in the read state; a seeded test article is a 404", async () => {
    const user = await createUser({ name: "Sanne" });
    const token = tokenFor(user);
    await Promise.all([makeArticle(3, "news"), makeArticle(900001, "news")]);
    expect((await request("/articles/3/read", { method: "POST", token })).status).toBe(204);
    expect((await request("/articles/900001/read", { method: "POST", token })).status).toBe(404);
    const res = await request("/articles/read", { token });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ read: [3], readBy: { "3": ["Sanne"] } });
  });

  test("read state lists the readers of an article by name, sorted", async () => {
    const [sanne, daan] = [await createUser({ name: "Sanne" }), await createUser({ name: "Daan" })];
    await makeArticle(3, "news");
    for (const user of [sanne, daan]) expect((await request("/articles/3/read", { method: "POST", token: tokenFor(user) })).status).toBe(204);
    const state = (await (await request("/articles/read", { token: tokenFor(sanne) })).json()) as { read: number[]; readBy: Record<string, string[]> };
    expect(state).toEqual({ read: [3], readBy: { "3": ["Daan", "Sanne"] } });
  });

  test("an admin's user answers never carry the read articles", async () => {
    const admin = await createUser({ admin: true });
    const token = tokenFor(admin);
    const user = await createUser();
    await User.updateOne({ _id: user._id }, { $set: { readArticles: [3] } });
    const list = await request("/admin/users", { token });
    expect(list.status).toBe(200);
    expect(JSON.stringify(await list.json())).not.toContain("readArticles");
    const updated = await request(`/admin/users/${user._id}`, { method: "PUT", token, json: { name: "Anders" } });
    expect(updated.status).toBe(200);
    expect(JSON.stringify(await updated.json())).not.toContain("readArticles");
  });

  test("an admin can't give a user a name over 40 characters", async () => {
    const token = tokenFor(await createUser({ admin: true }));
    const user = await createUser();
    const tooLong = await request(`/admin/users/${user._id}`, { method: "PUT", token, json: { name: "x".repeat(41) } });
    expect(tooLong.status).toBe(400);
    expect(JSON.stringify(await tooLong.json())).toContain("Naam moet 1 tot 40 tekens zijn.");
    expect((await User.findById(user._id))?.name).toBe(user.name);
    const exact = await request(`/admin/users/${user._id}`, { method: "PUT", token, json: { name: "x".repeat(40) } });
    expect(exact.status).toBe(200);
  });
});

describe("markers", () => {
  test("POST /markers: our hint marker takes over an imported Jotiboard hint pin of that hour", async () => {
    const { Marker, MarkerType } = await import("./models/marker.model");
    const { HintCell } = await import("./models/hint-cell.model");
    const slot = new Date("2026-10-17T14:00:00.000Z");
    const imported = await Marker.create({ area: "alpha", time: slot, type: MarkerType.Hint, location: { type: "Point", coordinates: [5.6, 52.3] }, source: "jotiboard" });
    const linked = await HintCell.create({ articleId: 10, area: "alpha", publishAt: slot, slotTime: slot, markerId: imported._id });
    const user = await createUser();
    const res = await request("/markers", {
      method: "POST",
      token: tokenFor(user),
      json: { area: "alpha", type: MarkerType.Hint, time: "2026-10-17T14:20:00.000Z", location: { coordinates: [5.7, 52.4] } },
    });
    expect(res.status).toBe(201);
    const markers = await Marker.find().lean();
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ area: "alpha", time: slot, location: { coordinates: [5.7, 52.4] } });
    expect(markers[0].source).toBeUndefined();
    expect((await HintCell.findById(linked._id).lean())?.markerId).toBeUndefined();
  });

  test("DELETE /markers/:id: a deleted Jotiboard marker is not imported again", async () => {
    const { Marker } = await import("./models/marker.model");
    const { JotiboardImport } = await import("./models/jotiboard-import.model");
    const { jotiboardImporter } = await import("./services/jotiboard.import");
    const pin = { id: "p1", foxAreas: ["Bravo"], lat: 52.29, lon: 5.61, time: Date.parse("2026-10-17T14:20:00Z"), type: "other" as const };
    await jotiboardImporter.importPins([pin]);
    const imported = await Marker.findOne({ source: "jotiboard" }).lean();
    const res = await request(`/markers/${imported!._id}`, { method: "DELETE", token: tokenFor(await createUser()) });
    expect(res.status).toBe(200);
    expect(await JotiboardImport.findOne().lean()).toMatchObject({ result: "skipped", reason: "deleted" });
    await jotiboardImporter.importPins([pin]);
    expect(await Marker.countDocuments()).toBe(0);
  });

  test("POST /markers: a hint marker of ours on that hour still answers 409", async () => {
    const { Marker, MarkerType } = await import("./models/marker.model");
    await Marker.create({ area: "alpha", time: new Date("2026-10-17T14:00:00.000Z"), type: MarkerType.Hint, location: { type: "Point", coordinates: [5.6, 52.3] } });
    const res = await request("/markers", {
      method: "POST",
      token: tokenFor(await createUser()),
      json: { area: "alpha", type: MarkerType.Hint, time: "2026-10-17T14:20:00.000Z", location: { coordinates: [5.7, 52.4] } },
    });
    expect(res.status).toBe(409);
    expect(await Marker.countDocuments()).toBe(1);
  });
});

describe("write rate limit", () => {
  test("POST /markers answers 429 after 30 writes per minute per user", async () => {
    const [a, b] = [await createUser(), await createUser()];
    // Invalid bodies (400) still count: the limit runs before validation
    for (let i = 0; i < 30; i++) expect((await request("/markers", { method: "POST", token: tokenFor(a), json: {} })).status).toBe(400);
    const limited = await request("/markers", { method: "POST", token: tokenFor(a), json: {} });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(((await limited.json()) as { message: string }).message).toContain("Te veel");
    expect((await request("/markers", { method: "POST", token: tokenFor(b), json: {} })).status).toBe(400);
  });
});

describe("manual hunt registration is gone", () => {
  test("hunt reports answer 410, the photo setting 404; hunts come from the jotihunt.nl sync", async () => {
    const user = await createUser();
    // Old apps (Android 1.0.x) get a reason they can show
    for (const [path, method] of [["/hunt-reports", "GET"], ["/hunt-reports", "POST"], ["/hunt-reports/abc/photo", "GET"], ["/hunt-reports/abc", "PATCH"]]) {
      const res = await request(path, { method, token: tokenFor(user), ...(method === "GET" ? {} : { json: {} }) });
      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({ message: "Werk de app bij naar de nieuwste versie." });
    }
    expect((await request("/settings/hunt-photo", { token: tokenFor(user) })).status).toBe(404);
    expect((await request("/hunts/sync", { token: tokenFor(user) })).status).toBe(200);
  });
});

describe("http basics", () => {
  test("security headers, CORS preflight cache and no X-Powered-By", async () => {
    const res = await request("/nope");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-powered-by")).toBeNull();
    const preflight = await request("/markers", {
      method: "OPTIONS",
      headers: { Origin: "https://app.example.nl", "Access-Control-Request-Method": "POST" },
    });
    expect(preflight.headers.get("access-control-max-age")).toBe("86400");
  });

  test("large JSON is gzipped and ETag/304 still works", async () => {
    const admin = await createUser({ admin: true });
    await Promise.all(Array.from({ length: 30 }, () => createUser()));
    const token = tokenFor(admin);
    const first = await request("/admin/users", { token, headers: { "Accept-Encoding": "gzip" } });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-encoding")).toBe("gzip");
    expect(((await first.json()) as unknown[]).length).toBe(31);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const second = await request("/admin/users", { token, headers: { "Accept-Encoding": "gzip", "If-None-Match": etag! } });
    expect(second.status).toBe(304);
  });

  test("successful reads and preflights are not logged; errors and writes are", () => {
    expect(isQuietRequest("GET", 200)).toBe(true);
    expect(isQuietRequest("GET", 304)).toBe(true);
    expect(isQuietRequest("OPTIONS", 204)).toBe(true);
    expect(isQuietRequest("GET", 401)).toBe(false);
    expect(isQuietRequest("GET", 500)).toBe(false);
    expect(isQuietRequest("POST", 201)).toBe(false);
  });
});

describe("hints: clearing an answer", () => {
  test("DELETE /hints/:articleId/:area/solve opens the cell again; 401 without token, 400 for an unknown area", async () => {
    const slotTime = new Date("2026-10-17T12:00:00Z");
    await HintCell.create({ articleId: 3, area: "alpha", publishAt: slotTime, slotTime, status: HintCellStatus.Solved, answer: "kerk", answerKind: "text" });
    expect((await request("/hints/3/alpha/solve", { method: "DELETE" })).status).toBe(401);
    const token = tokenFor(await createUser());
    expect((await request("/hints/3/zulu/solve", { method: "DELETE", token })).status).toBe(400);
    const res = await request("/hints/3/alpha/solve", { method: "DELETE", token });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ area: "alpha", status: "open" });
  });
});

describe("notification preferences", () => {
  test("PUT drops unknown or removed types instead of rejecting them", async () => {
    const user = await createUser();
    const res = await request("/notifications/preferences", { method: "PUT", token: tokenFor(user), json: { disabledTypes: ["hunt-deadline", "hint", 5] } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { disabledTypes: string[] }).disabledTypes).toEqual(["hint"]);
  });
});
