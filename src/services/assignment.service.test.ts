import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Article } from "../models/article.model";
import { Assignment, AssignmentStatus } from "../models/assignment.model";
import { User } from "../models/user.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import { ServiceError } from "../http/service-error";
import { addAssignmentNote, listAssignments, listMembers, setAssignmentOwner, setAssignmentStatus } from "./assignment.service";

const makeUser = (name: string) => User.create({ name });
const makeArticle = (id = 7, type = "assignment") => Article.create({ id, title: "Doedelzak", type, publishAt: new Date("2026-10-17T12:00:00Z"), content: "<div>bouw</div>" });

async function expectError(promise: Promise<unknown>, status: number) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).status).toBe(status);
    return error as ServiceError;
  }
  throw new Error(`Expected ServiceError ${status}`);
}

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("setAssignmentStatus", () => {
  test("creates the document on the first write and records who and when", async () => {
    const [user] = await Promise.all([makeUser("sanne"), makeArticle()]);
    const view = await setAssignmentStatus(7, AssignmentStatus.Busy, user._id);
    expect(view.status).toBe(AssignmentStatus.Busy);
    expect((view.statusBy as unknown as { name: string }).name).toBe("sanne");
    expect(view.statusAt).toBeInstanceOf(Date);
    expect(await Assignment.countDocuments()).toBe(1);
  });

  test("404 for a missing article and for an article that is not an assignment", async () => {
    const [user] = await Promise.all([makeUser("sanne"), makeArticle(8, "news")]);
    expect((await expectError(setAssignmentStatus(99, AssignmentStatus.Busy, user._id), 404)).message).toBe("Opdracht niet gevonden");
    await expectError(setAssignmentStatus(8, AssignmentStatus.Busy, user._id), 404);
  });

  test("anyone may change a status someone else set; the last write wins", async () => {
    const [a, b] = await Promise.all([makeUser("sanne"), makeUser("daan"), makeArticle()]);
    await setAssignmentStatus(7, AssignmentStatus.Busy, a._id);
    const view = await setAssignmentStatus(7, AssignmentStatus.Skipped, b._id);
    expect(view.status).toBe(AssignmentStatus.Skipped);
    expect((view.statusBy as unknown as { name: string }).name).toBe("daan");
  });
});

describe("setAssignmentOwner", () => {
  test("assigns and unassigns", async () => {
    const [a, b] = await Promise.all([makeUser("sanne"), makeUser("daan"), makeArticle()]);
    const view = await setAssignmentOwner(7, String(b._id), a._id);
    expect((view.owner as unknown as { name: string }).name).toBe("daan");
    expect((view.ownerBy as unknown as { name: string }).name).toBe("sanne");
    const cleared = await setAssignmentOwner(7, null, a._id);
    expect(cleared.owner ?? null).toBeNull();
  });

  test("400 for an unknown user", async () => {
    const [a] = await Promise.all([makeUser("sanne"), makeArticle()]);
    expect((await expectError(setAssignmentOwner(7, "64b7f0f0f0f0f0f0f0f0f0f0", a._id), 400)).message).toBe("Onbekende gebruiker");
  });

  test("anyone may take over an owned assignment or hand it back", async () => {
    const [a, b] = await Promise.all([makeUser("sanne"), makeUser("daan"), makeArticle()]);
    await setAssignmentOwner(7, String(a._id), a._id);
    expect(((await setAssignmentOwner(7, String(b._id), b._id)).owner as unknown as { name: string }).name).toBe("daan");
    expect((await setAssignmentOwner(7, null, a._id)).owner ?? null).toBeNull();
  });
});

describe("notes, list, members", () => {
  test("addAssignmentNote appends with the author; listAssignments returns populated documents", async () => {
    const [a] = await Promise.all([makeUser("sanne"), makeArticle()]);
    await addAssignmentNote(7, a._id, "blokfluiten liggen klaar");
    const [view] = await listAssignments();
    expect(view.articleId).toBe(7);
    expect(view.status).toBe(AssignmentStatus.Open);
    expect(view.notes).toHaveLength(1);
    expect((view.notes[0].user as unknown as { name: string }).name).toBe("sanne");
    expect(view.notes[0].text).toBe("blokfluiten liggen klaar");
  });

  test("listAssignments includes what jotihunt.nl showed; status set by jotihunt.nl has statusBy null", async () => {
    await makeArticle();
    const checkedAt = new Date("2026-10-17T13:00:00Z");
    const site = { submitted: true, imageUrl: "https://cdn.jotihunt.net/a.jpg", rating: null, judgement: "Nog niet beoordeeld", judged: false, points: null, checkedAt };
    await Assignment.create({ articleId: 7, status: AssignmentStatus.Submitted, statusBy: null, statusAt: checkedAt, site });
    await Assignment.create({ articleId: 8 });
    const [checked, unchecked] = JSON.parse(JSON.stringify(await listAssignments())) as Record<string, unknown>[];
    expect(checked).toMatchObject({ articleId: 7, status: "submitted", statusBy: null, site: { ...site, checkedAt: checkedAt.toISOString() } });
    expect(unchecked).toMatchObject({ articleId: 8, site: null });
  });

  test("listMembers returns only ids and names, sorted by name", async () => {
    await Promise.all([makeUser("sanne"), makeUser("daan")]);
    const members = await listMembers();
    expect(members.map((member) => member.name)).toEqual(["daan", "sanne"]);
    expect(Object.keys(members[0]).sort()).toEqual(["_id", "name"]);
  });
});
