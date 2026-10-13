import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { User } from "../models/user.model";
import { tokenFor, withSession } from "../test/auth";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";
const { app } = await import("../app");

const uploads = mkdtempSync(path.join(tmpdir(), "hunt-route-photos-"));
const PHOTO = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 1)]);
const THUMB = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 2)]);

let server: Server;
let base: string;
let previousUploadsDir: string | undefined;

beforeAll(async () => {
  previousUploadsDir = process.env.UPLOADS_DIR;
  process.env.UPLOADS_DIR = uploads;
  await connectTestDb();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  await clearTestDb();
  rmSync(uploads, { recursive: true, force: true });
});
afterAll(async () => {
  server.close();
  await disconnectTestDb();
  rmSync(uploads, { recursive: true, force: true });
  process.env.UPLOADS_DIR = previousUploadsDir;
});

async function token() {
  const user = await withSession(await User.create({ name: "Hunter" }));
  return tokenFor(user);
}

function upload(auth: string, files: { photo?: Buffer; thumb?: Buffer }, uploadId?: string) {
  const form = new FormData();
  if (files.photo) form.append("photo", new Blob([new Uint8Array(files.photo)], { type: "image/jpeg" }), "hunt.jpg");
  if (files.thumb) form.append("thumb", new Blob([new Uint8Array(files.thumb)], { type: "image/jpeg" }), "thumb.jpg");
  form.append("area", "alpha");
  // Code and time given: nothing is queued for reading
  form.append("huntCode", "ABC123");
  form.append("huntTime", "2026-10-17T12:00:00Z");
  if (uploadId) form.append("uploadId", uploadId);
  return fetch(`${base}/hunt-reports`, { method: "POST", body: form, headers: { Authorization: `Bearer ${auth}` } });
}

async function photo(auth: string, url: string) {
  const response = await fetch(`${base}${url}`, { headers: { Authorization: `Bearer ${auth}` } });
  return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
}

describe("hunt report thumbnails", () => {
  test("an uploaded thumb is served at thumbUrl; photoUrl stays the full photo", async () => {
    const auth = await token();
    const response = await upload(auth, { photo: PHOTO, thumb: THUMB });
    expect(response.status).toBe(201);
    const view = (await response.json()) as { photoUrl: string; thumbUrl: string };
    expect(view.thumbUrl).toBe(`${view.photoUrl}?size=thumb`);
    expect((await photo(auth, view.thumbUrl)).body).toEqual(THUMB);
    expect((await photo(auth, view.photoUrl)).body).toEqual(PHOTO);
  });

  test("without a thumb the thumb URL serves the full photo", async () => {
    const auth = await token();
    const view = (await (await upload(auth, { photo: PHOTO })).json()) as { thumbUrl: string };
    expect((await photo(auth, view.thumbUrl)).body).toEqual(PHOTO);
  });

  test("an oversized or fake thumb is dropped; the hunt is still stored", async () => {
    const auth = await token();
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400 * 1024)]);
    const first = await upload(auth, { photo: PHOTO, thumb: big });
    expect(first.status).toBe(201);
    expect((await photo(auth, ((await first.json()) as { thumbUrl: string }).thumbUrl)).body).toEqual(PHOTO);
    const second = await upload(auth, { photo: PHOTO, thumb: Buffer.from("<svg onload=alert(1)>") });
    expect(second.status).toBe(201);
    expect((await photo(auth, ((await second.json()) as { thumbUrl: string }).thumbUrl)).body).toEqual(PHOTO);
    expect(readdirSync(uploads)).toHaveLength(2);
  });

  test("a thumb without a photo is still refused", async () => {
    const auth = await token();
    expect((await upload(auth, { thumb: THUMB })).status).toBe(400);
  });

  test("an unknown size is refused", async () => {
    const auth = await token();
    const view = (await (await upload(auth, { photo: PHOTO })).json()) as { photoUrl: string };
    expect((await photo(auth, `${view.photoUrl}?size=huge`)).status).toBe(400);
  });
});
