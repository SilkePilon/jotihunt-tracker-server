import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { archiveReadOnly } from "./archive-read-only";
import { setArchiveFlag } from "./work-tracking";

const app = express();
app.use(archiveReadOnly);
app.all("/{*path}", (_req, res) => res.json({ ok: true }));

let server: Server;
let base: string;
beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
afterEach(() => setArchiveFlag(false));

const send = (method: string, path: string) => fetch(`${base}${path}`, { method });

test("writes pass while the live edition is shown", async () => {
  expect((await send("POST", "/markers")).status).toBe(200);
});

test("writes to game data get 423 while an archive is shown", async () => {
  setArchiveFlag(true);
  const res = await send("POST", "/markers");
  expect(res.status).toBe(423);
  expect(await res.json()).toEqual({ message: "Archief is alleen-lezen" });
  expect((await send("DELETE", "/hunts/1")).status).toBe(423);
  expect((await send("PUT", "/teams/1/area")).status).toBe(423);
});

test("reads and account/admin writes still pass in the archive", async () => {
  setArchiveFlag(true);
  expect((await send("GET", "/markers")).status).toBe(200);
  expect((await send("HEAD", "/markers")).status).toBe(200);
  expect((await send("OPTIONS", "/markers")).status).toBe(200);
  for (const path of ["/intel-chat", "/intel-chat/stream", "/auth/login", "/account/passkeys/x", "/admin/config/general", "/admin/users/1", "/invites/abc"]) {
    expect((await send("POST", path)).status).toBe(200);
  }
  expect((await send("POST", "/admin/broadcast")).status).toBe(423);
  // Push subscriptions would only land in the archive's copy (the live edition holds the master)
  expect((await send("POST", "/push/subscribe")).status).toBe(423);
  expect((await send("PUT", "/push/subscribe")).status).toBe(423);
  // Unsubscribing (logout) is allowed: exactly DELETE /push/subscribe
  expect((await send("DELETE", "/push/subscribe")).status).toBe(200);
  expect((await send("DELETE", "/push/subscribe/x")).status).toBe(423);
  // A prefix only matches whole path segments
  expect((await send("POST", "/authx")).status).toBe(423);
});
