import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Area } from "../models/area.model";
import { AreaStatusEvent } from "../models/area-status-event.model";
import { HintCell, HintCellStatus } from "../models/hint-cell.model";
import { Hunt } from "../models/hunt.model";
import { Marker, MarkerType } from "../models/marker.model";
import { User } from "../models/user.model";
import { tokenFor, withSession } from "../test/auth";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";
const { app } = await import("../app");

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

const get = (path: string, token?: string) => fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const webUser = async () => tokenFor(await withSession(await User.create({ name: "Hunter" })));
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

describe("GET /areas/:area/history", () => {
  test("needs a token", async () => {
    expect((await get("/areas/alpha/history")).status).toBe(401);
  });

  test("the fox's last 3 hours; geen-hint cells and tegenhunts left out", async () => {
    const point = { type: "Point" as const, coordinates: [5.9, 52.0] };
    await Area.create({ name: "Alpha", status: "red", updatedAt: ago(120) });
    await AreaStatusEvent.create([
      { area: "Alpha", status: "green", at: ago(360) },
      { area: "Alpha", status: "red", at: ago(120) },
    ]);
    await HintCell.create([
      { articleId: 1, area: "alpha", status: HintCellStatus.Open, publishAt: ago(60), slotTime: ago(60) },
      { articleId: 2, area: "alpha", status: HintCellStatus.None, publishAt: ago(60), slotTime: ago(60) },
    ]);
    await Marker.create({ area: "alpha", type: MarkerType.Spot, time: ago(30), location: point });
    const hunt = (minutes: number, statusClass: "approved" | "rejected", statusText: string) => ({
      area: "alpha",
      huntTime: ago(minutes),
      statusClass,
      status: statusText,
      statusText,
      points: 0,
      updatedAt: new Date(),
    });
    await Hunt.create([hunt(90, "approved", "Goedgekeurd"), hunt(50, "rejected", "Afgekeurd"), hunt(40, "approved", "Tegenhunt")]);

    const res = await get("/areas/Alpha/history?minutes=180", await webUser());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      area: "alpha",
      from: expect.any(String),
      to: expect.any(String),
      status: [
        { status: "green", from: body.from, to: expect.any(String) },
        { status: "red", from: expect.any(String), to: null },
      ],
      hints: [{ articleId: 1, publishAt: expect.any(String), solvedAt: null, title: expect.stringMatching(/^Hint \d\d:\d\d$/) }],
      spots: [{ id: expect.any(String), at: expect.any(String) }],
      hunts: [
        { id: expect.any(String), at: expect.any(String), result: "approved" },
        { id: expect.any(String), at: expect.any(String), result: "rejected" },
      ],
    });
    expect(new Date(body.to).getTime() - new Date(body.from).getTime()).toBe(180 * 60_000);
  });

  test("defaults to 180 minutes", async () => {
    await Area.create({ name: "Alpha", status: "green", updatedAt: ago(600) });
    const body = await (await get("/areas/alpha/history", await webUser())).json();
    expect(new Date(body.to).getTime() - new Date(body.from).getTime()).toBe(180 * 60_000);
  });

  test("unknown area or one not in the database: 404; bad minutes: 400", async () => {
    const token = await webUser();
    expect((await get("/areas/zulu/history", token)).status).toBe(404);
    expect((await get("/areas/alpha/history", token)).status).toBe(404);
    expect((await get("/areas/alpha/history?minutes=5", token)).status).toBe(400);
    expect((await get("/areas/alpha/history?minutes=601", token)).status).toBe(400);
    expect((await get("/areas/alpha/history?minutes=abc", token)).status).toBe(400);
  });
});
