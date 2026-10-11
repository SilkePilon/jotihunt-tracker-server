import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectTestDb, disconnectTestDb } from "../test/db";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";
const dir = mkdtempSync(path.join(tmpdir(), "app-releases-"));
process.env.APP_DIR = dir;
const { app } = await import("../app");

let server: Server;
let base: string;
beforeAll(async () => {
  await connectTestDb();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await disconnectTestDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("app releases", () => {
  test("no release yet: 404 with a Dutch message", async () => {
    const response = await fetch(`${base}/app/latest`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { message: string }).message).toBe("Nog geen app beschikbaar.");
  });

  test("latest + download", async () => {
    writeFileSync(path.join(dir, "jotihunt-1.0.0.apk"), "APKDATA");
    writeFileSync(path.join(dir, "latest.json"), JSON.stringify({ versionCode: 1, versionName: "1.0.0", file: "jotihunt-1.0.0.apk", sha256: "ab" }));
    const latest = await fetch(`${base}/app/latest`);
    expect(latest.status).toBe(200);
    expect(await latest.json()).toEqual({ versionCode: 1, versionName: "1.0.0", sha256: "ab", url: "/app/download/jotihunt-1.0.0.apk" });
    const download = await fetch(`${base}/app/download/jotihunt-1.0.0.apk`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toContain("application/vnd.android.package-archive");
    expect(await download.text()).toBe("APKDATA");
  });

  test("only .apk files inside APP_DIR are served", async () => {
    expect((await fetch(`${base}/app/download/latest.json`)).status).toBe(404);
    expect((await fetch(`${base}/app/download/..%2Fsecret.apk`)).status).toBe(404);
    expect((await fetch(`${base}/app/download/missing.apk`)).status).toBe(404);
  });

  test("latest.json pointing at a missing APK is treated as no release", async () => {
    writeFileSync(path.join(dir, "latest.json"), JSON.stringify({ versionCode: 2, versionName: "2.0.0", file: "gone.apk", sha256: "cd" }));
    expect((await fetch(`${base}/app/latest`)).status).toBe(404);
  });

  test("a broken latest.json is treated as no release", async () => {
    writeFileSync(path.join(dir, "latest.json"), "{ nope");
    expect((await fetch(`${base}/app/latest`)).status).toBe(404);
  });
});
