import { describe, expect, test } from "bun:test";
import { checkCreate, checkShow, editionOf, isArchive, migrateRegistry, nextEditionRegistry, type EditionsDoc } from "./registry";

const NOW = new Date("2026-10-20T12:00:00Z");
const HUNT = { huntStart: "2026-10-17T08:00:00.000Z", huntEnd: "2026-10-18T10:00:00.000Z" };

describe("migrateRegistry", () => {
  test("no registry: 2026 on the control database, live and shown, hunt times copied", () => {
    const doc = migrateRegistry(null, "jotihunt", HUNT, NOW);
    expect(doc).toEqual({ key: "editions", editions: [{ year: 2026, dbName: "jotihunt", createdAt: NOW, ...HUNT }], liveYear: 2026, shownYear: 2026 });
  });
  test("existing registry is returned unchanged", () => {
    const existing = migrateRegistry(null, "jotihunt", HUNT, NOW);
    expect(migrateRegistry(existing, "other", { huntStart: null, huntEnd: null }, NOW)).toBe(existing);
  });
});

describe("nextEditionRegistry", () => {
  test("adds live year + 1 on its own database, makes it live and shown, no hunt times", () => {
    const doc = nextEditionRegistry(migrateRegistry(null, "jotihunt", HUNT, NOW), "jotihunt", NOW);
    expect(editionOf(doc, 2027)).toEqual({ year: 2027, dbName: "jotihunt-2027", createdAt: NOW, huntStart: null, huntEnd: null });
    expect(doc.liveYear).toBe(2027);
    expect(doc.shownYear).toBe(2027);
    expect(isArchive(doc)).toBe(false);
  });
});

describe("checkShow", () => {
  const base: EditionsDoc = nextEditionRegistry(migrateRegistry(null, "jotihunt", HUNT, NOW), "jotihunt", NOW);
  const live = (huntStart: string | null, huntEnd: string | null): EditionsDoc => ({
    ...base,
    editions: base.editions.map((e) => (e.year === 2027 ? { ...e, huntStart, huntEnd } : e)),
  });

  test("unknown year → 404", () => {
    expect(checkShow(base, 2019, NOW)).toEqual({ ok: false, status: 404, message: "Die editie bestaat niet" });
  });
  test("archive outside the live hunt is allowed", () => {
    expect(checkShow(live("2027-10-16T08:00:00Z", "2027-10-17T10:00:00Z"), 2026, NOW)).toEqual({ ok: true });
  });
  test("archive during the live hunt → 409", () => {
    const during = new Date("2027-10-16T20:00:00Z");
    expect(checkShow(live("2027-10-16T08:00:00Z", "2027-10-17T10:00:00Z"), 2026, during)).toEqual({ ok: false, status: 409, message: "Archief kan niet tijdens de hunt" });
  });
  test("the live edition is always allowed, also during its hunt", () => {
    const during = new Date("2027-10-16T20:00:00Z");
    expect(checkShow(live("2027-10-16T08:00:00Z", "2027-10-17T10:00:00Z"), 2027, during)).toEqual({ ok: true });
  });
  test("checkCreate refuses during the live hunt", () => {
    const during = new Date("2027-10-16T20:00:00Z");
    expect(checkCreate(live("2027-10-16T08:00:00Z", "2027-10-17T10:00:00Z"), during).ok).toBe(false);
    expect(checkCreate(base, NOW)).toEqual({ ok: true });
  });
});
