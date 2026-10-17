import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import mongoose from "mongoose";
import { Article } from "../models/article.model";
import { Assignment, AssignmentStatus } from "../models/assignment.model";
import { User } from "../models/user.model";
import { assignmentsToCheck, storeSubmission } from "../services/assignment-sync.service";
import { initAppConfig, resetAppConfig } from "../settings/app-config";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import syncJotihuntAssignments from "./jotihunt-assignments.cron";

const LOGIN = { JOTIHUNT_WEB_USERNAME: "team@example.nl", JOTIHUNT_WEB_PASSWORD: "hunter2" };
const fixture = (name: string) => readFileSync(join(import.meta.dir, "..", "services", "__fixtures__", name), "utf8");
const now = new Date("2026-10-17T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

const article = (id: number, publishAt: Date, type = "assignment") => Article.create({ id, title: `Opdracht ${id}`, type, publishAt, content: "<p>Doe iets</p>" });
const handedIn = { submitted: true, imageUrl: "https://cdn.jotihunt.net/a.jpg", rating: 4, judgement: "Nog niet beoordeeld", judged: false, points: null };
const notHandedIn = { submitted: false, imageUrl: null, rating: null, judgement: null, judged: false, points: null };

beforeAll(connectTestDb);
beforeEach(async () => {
  await clearTestDb();
  await initAppConfig(mongoose.connection, LOGIN);
});
afterAll(async () => {
  resetAppConfig();
  await disconnectTestDb();
});

describe("assignmentsToCheck", () => {
  test("published assignments only, newest first, judged ones skipped, at most the limit", async () => {
    await article(1, minutesAgo(300));
    await article(2, minutesAgo(200));
    await article(3, minutesAgo(100));
    await article(4, minutesAgo(-10)); // not published yet
    await article(5, minutesAgo(50), "news");
    await article(900001, minutesAgo(5)); // seeded test article
    await Assignment.create({ articleId: 2, site: { ...handedIn, judged: true, judgement: "Beoordeeld: 5 punten", points: 5, checkedAt: minutesAgo(1) } });
    expect(await assignmentsToCheck(now)).toEqual([3, 1]);
    expect(await assignmentsToCheck(now, 1)).toEqual([3]);
  });

  test("never checked first, then the longest ago", async () => {
    for (const id of [1, 2, 3]) await article(id, minutesAgo(100 - id));
    await storeSubmission(3, notHandedIn, minutesAgo(5));
    await storeSubmission(2, notHandedIn, minutesAgo(10));
    expect(await assignmentsToCheck(now)).toEqual([1, 2, 3]);
  });
});

describe("storeSubmission", () => {
  test("handed in without a document: creates it as submitted by jotihunt.nl", async () => {
    expect(await storeSubmission(7, handedIn, now)).toBe(true);
    const stored = await Assignment.findOne({ articleId: 7 }).lean();
    expect(stored).toMatchObject({ status: "submitted", statusBy: null, statusAt: now, site: { ...handedIn, checkedAt: now } });
  });

  test("open or busy becomes submitted; people's submitted or skipped stays", async () => {
    const user = await User.create({ name: "Hunter" });
    const before = minutesAgo(30);
    await Assignment.create([
      { articleId: 1, status: AssignmentStatus.Open },
      { articleId: 2, status: AssignmentStatus.Busy, statusBy: user._id, statusAt: before },
      { articleId: 3, status: AssignmentStatus.Submitted, statusBy: user._id, statusAt: before },
      { articleId: 4, status: AssignmentStatus.Skipped, statusBy: user._id, statusAt: before },
    ]);
    expect(await Promise.all([1, 2, 3, 4].map((id) => storeSubmission(id, handedIn, now)))).toEqual([true, true, false, false]);
    const stored = await Assignment.find().sort({ articleId: 1 }).lean();
    expect(stored.map((entry) => [entry.status, entry.statusBy ? "user" : entry.statusBy])).toEqual([
      ["submitted", null],
      ["submitted", null],
      ["submitted", "user"],
      ["skipped", "user"],
    ]);
    expect(stored[2].statusAt).toEqual(before);
    expect(stored.every((entry) => entry.site?.submitted)).toBe(true);
  });

  test("not handed in: only the site part is stored, the status stays", async () => {
    await Assignment.create({ articleId: 1, status: AssignmentStatus.Busy });
    expect(await storeSubmission(1, notHandedIn, now)).toBe(false);
    expect(await Assignment.findOne({ articleId: 1 }).lean()).toMatchObject({ status: "busy", site: { submitted: false, checkedAt: now } });
  });
});

describe("assignments cron", () => {
  test("does nothing without a jotihunt.nl login", async () => {
    await initAppConfig(mongoose.connection, {});
    await article(1, minutesAgo(10));
    const paths: string[] = [];
    await syncJotihuntAssignments({ fetch: async (path) => (paths.push(path), { status: 200, html: "" }), now: () => now });
    expect(paths).toEqual([]);
    expect(await Assignment.countDocuments()).toBe(0);
  });

  test("reads at most 5 pages; a failing page is skipped, the others are stored", async () => {
    for (let id = 1; id <= 7; id++) await article(id, minutesAgo(100 - id));
    const pages: Record<string, string> = {
      "/bericht/7": fixture("assignment-submitted-rated.html"),
      "/bericht/6": fixture("assignment-open.html"),
      "/bericht/4": fixture("assignment-judged-synthetic.html"),
      "/bericht/3": "<main>Iets anders</main>",
    };
    const paths: string[] = [];
    await syncJotihuntAssignments({
      fetch: async (path) => {
        paths.push(path);
        if (path === "/bericht/5") throw new Error("socket hang up");
        return { status: 200, html: pages[path] };
      },
      now: () => now,
    });
    expect(paths).toEqual(["/bericht/7", "/bericht/6", "/bericht/5", "/bericht/4", "/bericht/3"]);
    const stored = new Map((await Assignment.find().lean()).map((entry) => [entry.articleId, entry]));
    expect([...stored.keys()].sort()).toEqual([4, 6, 7]);
    expect(stored.get(7)).toMatchObject({ status: "submitted", statusBy: null, site: { submitted: true, rating: 4, judged: false } });
    expect(stored.get(6)).toMatchObject({ status: "open", site: { submitted: false } });
    expect(stored.get(4)).toMatchObject({ status: "submitted", site: { judged: true, points: 25 } });

    // Judged 4 is never opened again
    paths.length = 0;
    await syncJotihuntAssignments({ fetch: async (path) => (paths.push(path), { status: 200, html: pages[path] ?? "" }), now: () => now });
    expect(paths).not.toContain("/bericht/4");
  });

  test("a failed login ends the run", async () => {
    for (let id = 1; id <= 3; id++) await article(id, minutesAgo(100 - id));
    let calls = 0;
    await syncJotihuntAssignments({
      fetch: async () => {
        calls++;
        throw new Error("Login failed (POST /login → back to /login)");
      },
      now: () => now,
    });
    expect(calls).toBe(1);
  });
});
