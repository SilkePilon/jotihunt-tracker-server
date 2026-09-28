# Hunt Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hunters register a hunt from their phone (photo + OCR'd code + handwritten time + fox team); HQ sees every report live with a 30-minute submit countdown, submits it by hand on jotihunt.nl, marks it "Ingestuurd", and the app links it to the scraped site status/points.

**Architecture:** Server: new `HuntReport` Mongoose model, pure helpers (code normalisation, derived status), a service (create/list/submit/delete/link scraped hunts), photos in a Docker volume served through an authenticated route, multer for multipart. Client: pure helpers in `lib/hunt-reports.ts`, an SWR hook, Tesseract.js OCR in the browser, a registration dialog opened from a mobile camera button or the sidebar card, a "Hunts" sidebar section and an "Alle hunts" dialog.

**Tech Stack:** Server: Bun 1.4, Express 5, Mongoose 9, express-validator, multer 2, bun:test. Client: React 19, Vite 8, Tailwind 4, shadcn new-york (`radix-ui`), SWR 2, zustand 5, sonner, tesseract.js 7, bun:test.

**Spec:** `docs/superpowers/specs/2026-09-28-hunt-registration-design.md` (server repo).

## Global Constraints

- Repos: server `/home/silke/Documents/Jotihunt 2026/jotihunt-tracker-server`, client `/home/silke/Documents/Jotihunt 2026/jotihunt-tracker-client`; branch `feat/hunt-registration` in both (already created, stacked on `feat/traccar-onboarding`).
- Bun is not installed on the host. Run every bun command through Docker, from the repo directory:
  `bun_() { docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp --network jotihunt_default -e MONGO_URI_TEST=mongodb://mongodb:27017/jotihunt-test -v "$PWD":/app -w /app oven/bun:1 bun "$@"; }`
  (the `jotihunt` compose stack with `mongodb` must be running: `cd "/home/silke/Documents/Jotihunt 2026" && docker compose up -d mongodb`).
- The app never submits anything to jotihunt.nl. Submission is manual by HQ.
- OCR runs only in the browser (tesseract.js). The photo is never sent to any third party. Tesseract's static assets (worker, wasm core, `eng` language data) load from its default CDN; that request carries no user data.
- Never send the user's email or any personal data to external services. Never log tokens or API keys.
- Submit window: `huntTime + 30 min`. Photo types: `image/jpeg`, `image/png`, `image/webp`; max 5 MB.
- Hunt codes are normalised as: remove all whitespace, uppercase.
- Areas (lowercase): `alpha, bravo, charlie, delta, echo, foxtrot, golf, hotel, oscar`.
- UI copy Dutch. Times 24 h, `nl-NL`.
- Server style: double quotes, semicolons, 2 spaces, printWidth 200. Client style: single quotes, semicolons, 2 spaces, printWidth 200.
- Client lint uses React Compiler rules (eslint-plugin-react-hooks v7): no ref reads during render, no synchronous `setState` inside `useEffect` bodies (setState in async callbacks/timeouts is fine; "adjust state during render" with a `prev` state is fine).
- Commit after each task; commit messages end with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Do not push.

---

## File Structure

Server (`jotihunt-tracker-server`):
- Create `src/services/hunt-report.helpers.ts` — constants, `normalizeHuntCode`, `submitDeadline`, `huntReportStatus`, `resolvePhotoExtension`.
- Create `src/services/hunt-report.helpers.test.ts`.
- Create `src/models/hunt-report.model.ts` — `HuntReport` model.
- Create `src/services/photo-store.ts` — write/read/delete photo files in `UPLOADS_DIR`.
- Create `src/services/hunt-report.service.ts` — `HuntReportError`, `createHuntReport`, `listHuntReports`, `setHuntReportSubmitted`, `deleteHuntReport`, `huntReportPhotoPath`, `linkScrapedHunts`, `toHuntReportView`.
- Create `src/services/hunt-report.service.test.ts`.
- Create `src/controllers/hunt-reports.controller.ts`, `src/routes/hunt-reports.route.ts`, `src/middleware/photo-upload.middleware.ts`.
- Modify `src/index.ts` (mount route), `src/crons/jotihunt-scraper.cron.ts` (link step), `package.json` (multer), `.gitignore` (`uploads/`), `README.md` (short Dutch section).
- Modify `/home/silke/Documents/Jotihunt 2026/docker-compose.yml` (named volume `uploads`), which is not in a git repo.

Client (`jotihunt-tracker-client`):
- Create `src/types/HuntReport.ts`.
- Create `src/lib/hunt-reports.ts` + `src/lib/hunt-reports.test.ts` — pure helpers.
- Modify `src/lib/fox-status.ts` + `src/lib/fox-status.test.ts` — cooldown also from reports.
- Create `src/hooks/hunt-reports.hook.ts` — SWR list + actions; `src/hooks/auth-image.hook.ts` — authenticated image as object URL.
- Create `src/lib/image.ts` — downscale a photo in the browser; `src/lib/ocr.ts` — lazy Tesseract worker.
- Create `src/stores/hunt-capture.store.ts` — the photo waiting to be registered + dialog open state.
- Create `src/components/hunts/HuntPhotoInput.tsx`, `HuntCaptureButton.tsx`, `HuntRegistrationDialog.tsx`, `HuntStatusBadge.tsx`, `HuntReportRow.tsx`, `HuntsSection.tsx`, `AllHuntsDialog.tsx`, `HuntDetail.tsx`, `NewHuntToaster.tsx`.
- Modify `src/stores/sidebar.store.ts`, `src/components/sidebar/SidebarSections.tsx`, `src/components/sidebar/FoxPills.tsx`, `src/pages/App.tsx`, `package.json` (tesseract.js).

---

### Task 1: Server helpers (normalisation, status, photo types)

**Files:**
- Create: `src/services/hunt-report.helpers.ts`
- Test: `src/services/hunt-report.helpers.test.ts`

**Interfaces:**
- Produces:
  - `HUNT_AREAS: readonly string[]`, `HUNT_KINDS = ["hunt", "tegenhunt"] as const`, `type HuntKind`
  - `SUBMIT_WINDOW_MS = 30 * 60 * 1000`, `MAX_PHOTO_BYTES = 5 * 1024 * 1024`
  - `type HuntReportStatus = "to_submit" | "overdue" | "submitted" | "judged"`
  - `normalizeHuntCode(code: string): string`
  - `submitDeadline(huntTime: Date): Date`
  - `huntReportStatus(report: { huntTime: Date; submittedAt?: Date | null; site?: { status: string } | null }, now: Date): HuntReportStatus`
  - `resolvePhotoExtension(mimetype: string): ".jpg" | ".png" | ".webp" | null`

- [ ] **Step 1: Write the failing test**

```ts
// src/services/hunt-report.helpers.test.ts
import { describe, expect, test } from "bun:test";
import { huntReportStatus, normalizeHuntCode, resolvePhotoExtension, submitDeadline, SUBMIT_WINDOW_MS } from "./hunt-report.helpers";

const huntTime = new Date("2026-10-17T12:00:00Z");

describe("normalizeHuntCode", () => {
  test("removes all whitespace and uppercases", () => {
    expect(normalizeHuntCode(" ab 12\tc\n")).toBe("AB12C");
  });
  test("keeps other characters", () => {
    expect(normalizeHuntCode("ab-12")).toBe("AB-12");
  });
});

describe("submitDeadline", () => {
  test("is 30 minutes after the hunt time", () => {
    expect(submitDeadline(huntTime).getTime() - huntTime.getTime()).toBe(SUBMIT_WINDOW_MS);
  });
});

describe("huntReportStatus", () => {
  test("to_submit up to and including the deadline", () => {
    expect(huntReportStatus({ huntTime }, new Date("2026-10-17T12:30:00Z"))).toBe("to_submit");
  });
  test("overdue after the deadline", () => {
    expect(huntReportStatus({ huntTime }, new Date("2026-10-17T12:30:01Z"))).toBe("overdue");
  });
  test("submitted wins over the deadline", () => {
    expect(huntReportStatus({ huntTime, submittedAt: new Date("2026-10-17T12:40:00Z") }, new Date("2026-10-17T13:00:00Z"))).toBe("submitted");
  });
  test("judged wins over submitted", () => {
    expect(huntReportStatus({ huntTime, submittedAt: new Date(), site: { status: "Goedgekeurd" } }, new Date())).toBe("judged");
  });
  test("null fields count as missing", () => {
    expect(huntReportStatus({ huntTime, submittedAt: null, site: null }, huntTime)).toBe("to_submit");
  });
});

describe("resolvePhotoExtension", () => {
  test("maps allowed image types", () => {
    expect(resolvePhotoExtension("image/jpeg")).toBe(".jpg");
    expect(resolvePhotoExtension("image/png")).toBe(".png");
    expect(resolvePhotoExtension("image/webp")).toBe(".webp");
  });
  test("rejects everything else", () => {
    expect(resolvePhotoExtension("image/gif")).toBeNull();
    expect(resolvePhotoExtension("application/pdf")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun_ test src/services/hunt-report.helpers.test.ts`
Expected: FAIL, cannot find module `./hunt-report.helpers`.

- [ ] **Step 3: Write the implementation**

```ts
// src/services/hunt-report.helpers.ts
/** Fox teams a hunt can be registered for (lowercase, like Marker.area). */
export const HUNT_AREAS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "oscar"] as const;
export const HUNT_KINDS = ["hunt", "tegenhunt"] as const;
export type HuntKind = (typeof HUNT_KINDS)[number];

/** A hunt code must be entered on jotihunt.nl within 30 minutes of the hunt (spelregels §5). */
export const SUBMIT_WINDOW_MS = 30 * 60 * 1000;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export type HuntReportStatus = "to_submit" | "overdue" | "submitted" | "judged";

const PHOTO_EXTENSIONS: Record<string, ".jpg" | ".png" | ".webp"> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

/** Hunt codes are compared without whitespace and case-insensitively. */
export function normalizeHuntCode(code: string): string {
  return code.replace(/\s+/g, "").toUpperCase();
}

export function submitDeadline(huntTime: Date): Date {
  return new Date(huntTime.getTime() + SUBMIT_WINDOW_MS);
}

/**
 * Status of a report: judged (the scraped site has it) > submitted (HQ clicked "Ingestuurd") > within the
 * 30-minute window > overdue.
 */
export function huntReportStatus(report: { huntTime: Date; submittedAt?: Date | null; site?: { status: string } | null }, now: Date): HuntReportStatus {
  if (report.site) return "judged";
  if (report.submittedAt) return "submitted";
  return now.getTime() <= submitDeadline(report.huntTime).getTime() ? "to_submit" : "overdue";
}

/** File extension for an allowed photo type, or null when the type is not allowed. */
export function resolvePhotoExtension(mimetype: string): ".jpg" | ".png" | ".webp" | null {
  return PHOTO_EXTENSIONS[mimetype] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun_ test src/services/hunt-report.helpers.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/hunt-report.helpers.ts src/services/hunt-report.helpers.test.ts
git commit -m "feat(hunts): hunt report helpers (code normalisation, status, photo types)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: HuntReport model, photo store and service

**Files:**
- Create: `src/models/hunt-report.model.ts`
- Create: `src/services/photo-store.ts`
- Create: `src/services/hunt-report.service.ts`
- Test: `src/services/hunt-report.service.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers; `Marker`, `MarkerType` from `src/models/marker.model.ts`; `UserType` from `src/models/user.model.ts`; `pointSchema` from `src/models/point.ts`; test DB helpers `connectTestDb`, `clearTestDb`, `disconnectTestDb` from `src/test/db.ts`.
- Produces:
  - `HuntReport` model; `type HuntReportDocument`
  - `savePhoto(buffer: Buffer, extension: string): Promise<string>` (returns file name), `photoFilePath(name: string): string` (absolute), `deletePhoto(name: string): Promise<void>` (ignores missing files)
  - `class HuntReportError extends Error { status: number; details: Record<string, unknown> }`
  - `interface NewHuntReport { area: string; huntCode: string; huntTime: Date; kind: HuntKind; photo: { buffer: Buffer; mimetype: string }; location?: [number, number] }`
  - `interface HuntReportView` (JSON sent to the client, see code)
  - `toHuntReportView(report: HuntReportDocument, now: Date): HuntReportView`
  - `createHuntReport(input: NewHuntReport, user: UserType): Promise<HuntReportView>`
  - `listHuntReports(now?: Date): Promise<HuntReportView[]>`
  - `setHuntReportSubmitted(id: string, submitted: boolean, user: UserType): Promise<HuntReportView>`
  - `deleteHuntReport(id: string, user: UserType): Promise<void>`
  - `huntReportPhotoPath(id: string): Promise<string>` (absolute path; 404 error when unknown)
  - `linkScrapedHunts(hunts: { huntCode: string | null; status: string | null; points: number }[], now?: Date): Promise<number>` (number of reports updated)

- [ ] **Step 1: Write the model**

```ts
// src/models/hunt-report.model.ts
import mongoose, { HydratedDocument, InferSchemaType } from "mongoose";
import { pointSchema } from "./point";
import { HUNT_AREAS, HUNT_KINDS } from "../services/hunt-report.helpers";

/** Last result of this code on jotihunt.nl, copied from the scraper (which only keeps the latest 15 hunts). */
const SiteResultSchema = new mongoose.Schema(
  {
    status: { type: String, required: true },
    points: { type: Number, required: true },
    seenAt: { type: Date, required: true },
  },
  { _id: false },
);

const HuntReportSchema = new mongoose.Schema(
  {
    area: { type: String, enum: HUNT_AREAS, required: true },
    /** Normalised: whitespace removed, uppercase */
    huntCode: { type: String, required: true, unique: true },
    huntTime: { type: Date, required: true },
    kind: { type: String, enum: HUNT_KINDS, required: true },
    /** File name in UPLOADS_DIR */
    photo: { type: String, required: true },
    reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    reportedByName: { type: String, required: true },
    location: { type: pointSchema, required: false },
    /** The hunt marker created with this report (feeds the fox prediction) */
    markerId: { type: mongoose.Schema.Types.ObjectId, required: false },
    submittedAt: { type: Date, required: false },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: false },
    submittedByName: { type: String, required: false },
    site: { type: SiteResultSchema, required: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const HuntReport = mongoose.model("HuntReport", HuntReportSchema);
export type HuntReportDocument = HydratedDocument<InferSchemaType<typeof HuntReportSchema>>;
```

- [ ] **Step 2: Write the photo store**

```ts
// src/services/photo-store.ts
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** Directory for hunt photos; in Docker a named volume at /usr/src/app/uploads. */
function uploadsDir(): string {
  return path.resolve(process.env.UPLOADS_DIR || "uploads");
}

/** Absolute path of a stored photo. Rejects names that would leave the uploads directory. */
export function photoFilePath(name: string): string {
  const base = path.basename(name);
  if (base !== name) throw new Error("Invalid photo name");
  return path.join(uploadsDir(), base);
}

/** Store a photo under a random name and return that name. */
export async function savePhoto(buffer: Buffer, extension: string): Promise<string> {
  await mkdir(uploadsDir(), { recursive: true });
  const name = `${randomUUID()}${extension}`;
  await writeFile(photoFilePath(name), buffer);
  return name;
}

/** Delete a stored photo; a missing file is not an error. */
export async function deletePhoto(name: string): Promise<void> {
  await unlink(photoFilePath(name)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
```

- [ ] **Step 3: Write the failing service test**

```ts
// src/services/hunt-report.service.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HuntReport } from "../models/hunt-report.model";
import { Marker } from "../models/marker.model";
import { User } from "../models/user.model";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../test/db";
import {
  createHuntReport,
  deleteHuntReport,
  huntReportPhotoPath,
  HuntReportError,
  linkScrapedHunts,
  listHuntReports,
  setHuntReportSubmitted,
  type NewHuntReport,
} from "./hunt-report.service";

process.env.UPLOADS_DIR = mkdtempSync(path.join(tmpdir(), "hunt-photos-"));

const huntTime = new Date("2026-10-17T12:03:00Z");

function input(overrides: Partial<NewHuntReport> = {}): NewHuntReport {
  return {
    area: "alpha",
    huntCode: " ab12 cd ",
    huntTime,
    kind: "hunt",
    photo: { buffer: Buffer.from([0xff, 0xd8, 0xff]), mimetype: "image/jpeg" },
    ...overrides,
  };
}

async function makeUser(name: string, admin = false) {
  return User.create({ email: `${name}@test.nl`, password: "x", name, admin });
}

async function expectReportError(promise: Promise<unknown>, status: number) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HuntReportError);
    expect((error as HuntReportError).status).toBe(status);
    return error as HuntReportError;
  }
  throw new Error(`Expected HuntReportError ${status}`);
}

beforeAll(connectTestDb);
beforeEach(clearTestDb);
afterAll(disconnectTestDb);

describe("createHuntReport", () => {
  test("stores a normalised code, the photo and the reporter", async () => {
    const user = await makeUser("merida");
    const view = await createHuntReport(input(), user);
    expect(view.huntCode).toBe("AB12CD");
    expect(view.reportedByName).toBe("merida");
    expect(view.status).toBe("to_submit");
    expect(view.photoUrl).toBe(`/hunt-reports/${view._id}/photo`);
    expect(existsSync(await huntReportPhotoPath(view._id))).toBe(true);
  });

  test("creates a hunt marker at the phone position", async () => {
    const user = await makeUser("merida");
    await createHuntReport(input({ location: [5.9, 52.2] }), user);
    const markers = await Marker.find();
    expect(markers).toHaveLength(1);
    expect(markers[0].type).toBe("hunt");
    expect(markers[0].area).toBe("alpha");
    expect(markers[0].location!.coordinates).toEqual([5.9, 52.2]);
    expect(markers[0].time.toISOString()).toBe("2026-10-17T12:03:00.000Z");
  });

  test("no marker without a position", async () => {
    const user = await makeUser("merida");
    await createHuntReport(input(), user);
    expect(await Marker.countDocuments()).toBe(0);
  });

  test("rejects a duplicate code with 409 and the first reporter's name", async () => {
    const merida = await makeUser("merida");
    const mulan = await makeUser("mulan");
    await createHuntReport(input(), merida);
    const error = await expectReportError(createHuntReport(input({ huntCode: "AB12CD" }), mulan), 409);
    expect(error.details).toEqual({ reason: "duplicate", reportedByName: "merida" });
    expect(await HuntReport.countDocuments()).toBe(1);
  });

  test("rejects an empty code and a disallowed photo type with 400", async () => {
    const user = await makeUser("merida");
    await expectReportError(createHuntReport(input({ huntCode: "  " }), user), 400);
    await expectReportError(createHuntReport(input({ photo: { buffer: Buffer.from("x"), mimetype: "image/gif" } }), user), 400);
  });
});

describe("setHuntReportSubmitted", () => {
  test("sets and clears the submitter", async () => {
    const merida = await makeUser("merida");
    const hq = await makeUser("hq");
    const report = await createHuntReport(input(), merida);
    const submitted = await setHuntReportSubmitted(report._id, true, hq);
    expect(submitted.status).toBe("submitted");
    expect(submitted.submittedByName).toBe("hq");
    const reverted = await setHuntReportSubmitted(report._id, false, hq);
    expect(reverted.submittedAt).toBeNull();
    expect(reverted.submittedByName).toBeNull();
  });

  test("404 for an unknown id", async () => {
    const hq = await makeUser("hq");
    await expectReportError(setHuntReportSubmitted("0123456789abcdef01234567", true, hq), 404);
  });
});

describe("deleteHuntReport", () => {
  test("reporter can delete while not submitted; photo and marker go too", async () => {
    const merida = await makeUser("merida");
    const report = await createHuntReport(input({ location: [5.9, 52.2] }), merida);
    const photo = await huntReportPhotoPath(report._id);
    await deleteHuntReport(report._id, merida);
    expect(await HuntReport.countDocuments()).toBe(0);
    expect(await Marker.countDocuments()).toBe(0);
    expect(existsSync(photo)).toBe(false);
  });

  test("an admin can delete someone else's report", async () => {
    const merida = await makeUser("merida");
    const admin = await makeUser("admin", true);
    const report = await createHuntReport(input(), merida);
    await deleteHuntReport(report._id, admin);
    expect(await HuntReport.countDocuments()).toBe(0);
  });

  test("403 for another non-admin user", async () => {
    const merida = await makeUser("merida");
    const mulan = await makeUser("mulan");
    const report = await createHuntReport(input(), merida);
    await expectReportError(deleteHuntReport(report._id, mulan), 403);
  });

  test("409 once submitted", async () => {
    const merida = await makeUser("merida");
    const report = await createHuntReport(input(), merida);
    await setHuntReportSubmitted(report._id, true, merida);
    await expectReportError(deleteHuntReport(report._id, merida), 409);
  });
});

describe("linkScrapedHunts", () => {
  test("copies status and points to the report with the same normalised code", async () => {
    const merida = await makeUser("merida");
    await createHuntReport(input(), merida);
    const now = new Date("2026-10-17T13:00:00Z");
    const updated = await linkScrapedHunts([{ huntCode: "ab12cd ", status: "Goedgekeurd", points: 5 }, { huntCode: null, status: null, points: 0 }], now);
    expect(updated).toBe(1);
    const [view] = await listHuntReports(now);
    expect(view.status).toBe("judged");
    expect(view.site).toEqual({ status: "Goedgekeurd", points: 5, seenAt: now.toISOString() });
  });
});

describe("listHuntReports", () => {
  test("newest hunt time first with derived status and deadline", async () => {
    const merida = await makeUser("merida");
    await createHuntReport(input({ huntCode: "OLD1", huntTime: new Date("2026-10-17T10:00:00Z") }), merida);
    await createHuntReport(input({ huntCode: "NEW1", huntTime: new Date("2026-10-17T12:00:00Z") }), merida);
    const views = await listHuntReports(new Date("2026-10-17T12:10:00Z"));
    expect(views.map((view) => view.huntCode)).toEqual(["NEW1", "OLD1"]);
    expect(views.map((view) => view.status)).toEqual(["to_submit", "overdue"]);
    expect(views[0].deadline).toBe("2026-10-17T12:30:00.000Z");
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun_ test src/services/hunt-report.service.test.ts`
Expected: FAIL, cannot find module `./hunt-report.service`.

- [ ] **Step 5: Write the service**

```ts
// src/services/hunt-report.service.ts
import mongoose from "mongoose";
import { HuntReport, type HuntReportDocument } from "../models/hunt-report.model";
import { Marker, MarkerType } from "../models/marker.model";
import type { UserType } from "../models/user.model";
import { huntReportStatus, normalizeHuntCode, resolvePhotoExtension, submitDeadline, type HuntKind, type HuntReportStatus } from "./hunt-report.helpers";
import { deletePhoto, photoFilePath, savePhoto } from "./photo-store";

export class HuntReportError extends Error {
  status: number;
  details: Record<string, unknown>;

  constructor(status: number, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export interface NewHuntReport {
  area: string;
  huntCode: string;
  huntTime: Date;
  kind: HuntKind;
  photo: { buffer: Buffer; mimetype: string };
  /** [lng, lat] of the phone at registration */
  location?: [number, number];
}

export interface HuntReportView {
  _id: string;
  area: string;
  huntCode: string;
  huntTime: string;
  kind: HuntKind;
  reportedBy: string;
  reportedByName: string;
  submittedAt: string | null;
  submittedByName: string | null;
  site: { status: string; points: number; seenAt: string } | null;
  createdAt: string;
  status: HuntReportStatus;
  deadline: string;
  photoUrl: string;
}

export function toHuntReportView(report: HuntReportDocument, now: Date): HuntReportView {
  const id = report._id.toString();
  return {
    _id: id,
    area: report.area,
    huntCode: report.huntCode,
    huntTime: report.huntTime.toISOString(),
    kind: report.kind as HuntKind,
    reportedBy: report.reportedBy.toString(),
    reportedByName: report.reportedByName,
    submittedAt: report.submittedAt ? report.submittedAt.toISOString() : null,
    submittedByName: report.submittedByName ?? null,
    site: report.site ? { status: report.site.status, points: report.site.points, seenAt: report.site.seenAt.toISOString() } : null,
    createdAt: (report.get("createdAt") as Date).toISOString(),
    status: huntReportStatus(report, now),
    deadline: submitDeadline(report.huntTime).toISOString(),
    photoUrl: `/hunt-reports/${id}/photo`,
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === 11000;
}

async function duplicateError(huntCode: string): Promise<HuntReportError> {
  const existing = await HuntReport.findOne({ huntCode });
  return new HuntReportError(409, "Deze code is al geregistreerd.", { reason: "duplicate", reportedByName: existing?.reportedByName ?? "iemand anders" });
}

async function findReport(id: string): Promise<HuntReportDocument> {
  const report = mongoose.isValidObjectId(id) ? await HuntReport.findById(id) : null;
  if (!report) throw new HuntReportError(404, "Hunt niet gevonden.");
  return report;
}

export async function createHuntReport(input: NewHuntReport, user: UserType): Promise<HuntReportView> {
  const huntCode = normalizeHuntCode(input.huntCode);
  if (!huntCode) throw new HuntReportError(400, "Huntcode ontbreekt.");
  const extension = resolvePhotoExtension(input.photo.mimetype);
  if (!extension) throw new HuntReportError(400, "Foto moet een JPEG, PNG of WebP zijn.");
  if (await HuntReport.exists({ huntCode })) throw await duplicateError(huntCode);

  const photo = await savePhoto(input.photo.buffer, extension);
  const time = new Date(input.huntTime);
  time.setSeconds(0, 0);
  const marker = input.location
    ? await Marker.create({ area: input.area, time, type: MarkerType.Hunt, location: { type: "Point", coordinates: input.location } })
    : null;

  try {
    const report = await HuntReport.create({
      area: input.area,
      huntCode,
      huntTime: time,
      kind: input.kind,
      photo,
      reportedBy: user._id,
      reportedByName: user.name,
      location: input.location ? { type: "Point", coordinates: input.location } : undefined,
      markerId: marker?._id,
    });
    return toHuntReportView(report, new Date());
  } catch (error) {
    // Undo the side effects; a concurrent registration of the same code loses the unique-index race
    await deletePhoto(photo);
    if (marker) await Marker.deleteOne({ _id: marker._id });
    if (isDuplicateKeyError(error)) throw await duplicateError(huntCode);
    throw error;
  }
}

export async function listHuntReports(now = new Date()): Promise<HuntReportView[]> {
  const reports = await HuntReport.find().sort({ huntTime: -1 });
  return reports.map((report) => toHuntReportView(report, now));
}

export async function setHuntReportSubmitted(id: string, submitted: boolean, user: UserType): Promise<HuntReportView> {
  const report = await findReport(id);
  if (submitted) {
    report.submittedAt = new Date();
    report.submittedBy = user._id;
    report.submittedByName = user.name;
  } else {
    report.submittedAt = undefined;
    report.submittedBy = undefined;
    report.submittedByName = undefined;
  }
  await report.save();
  return toHuntReportView(report, new Date());
}

export async function deleteHuntReport(id: string, user: UserType): Promise<void> {
  const report = await findReport(id);
  if (!user.admin && report.reportedBy.toString() !== user._id.toString()) {
    throw new HuntReportError(403, "Alleen de melder of een admin kan deze hunt verwijderen.");
  }
  if (report.submittedAt) throw new HuntReportError(409, "Deze hunt is al ingestuurd en kan niet meer verwijderd worden.");
  await HuntReport.deleteOne({ _id: report._id });
  if (report.markerId) await Marker.deleteOne({ _id: report.markerId });
  await deletePhoto(report.photo);
}

export async function huntReportPhotoPath(id: string): Promise<string> {
  const report = await findReport(id);
  return photoFilePath(report.photo);
}

/**
 * Copy the status and points of scraped jotihunt.nl hunts to the reports with the same normalised code.
 * Returns how many reports were updated.
 */
export async function linkScrapedHunts(hunts: { huntCode: string | null; status: string | null; points: number }[], now = new Date()): Promise<number> {
  let updated = 0;
  for (const hunt of hunts) {
    if (!hunt.huntCode) continue;
    const huntCode = normalizeHuntCode(hunt.huntCode);
    if (!huntCode) continue;
    const result = await HuntReport.updateOne(
      { huntCode },
      { $set: { site: { status: (hunt.status ?? "").trim(), points: Number.isFinite(hunt.points) ? hunt.points : 0, seenAt: now } } },
    );
    updated += result.modifiedCount;
  }
  return updated;
}
```

Note on `setHuntReportSubmitted`: assigning `undefined` to a Mongoose path unsets it, so the view returns `null` for both fields (asserted by the test).

- [ ] **Step 6: Run the tests**

Run: `bun_ test src/services/hunt-report.service.test.ts src/services/hunt-report.helpers.test.ts`
Expected: all PASS. Then `bun_ run typecheck` and `bun_ run lint`: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/models/hunt-report.model.ts src/services/photo-store.ts src/services/hunt-report.service.ts src/services/hunt-report.service.test.ts
git commit -m "feat(hunts): hunt report model, photo store and service

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Routes, upload middleware, scraper link, Docker volume

**Files:**
- Modify: `package.json` (add `multer`, dev `@types/multer`)
- Create: `src/middleware/photo-upload.middleware.ts`
- Create: `src/controllers/hunt-reports.controller.ts`
- Create: `src/routes/hunt-reports.route.ts`
- Modify: `src/index.ts` (import + `app.use("/hunt-reports", huntReportsRoute);` after the `/hunts` line)
- Modify: `src/crons/jotihunt-scraper.cron.ts`
- Modify: `.gitignore` (add `uploads/`), `.dockerignore` if present (add `uploads`)
- Modify: `README.md` (short Dutch section "Hunts registreren")
- Modify: `/home/silke/Documents/Jotihunt 2026/docker-compose.yml`

**Interfaces:**
- Consumes: Task 2 service functions and `HuntReportError`; `MAX_PHOTO_BYTES`, `HUNT_AREAS`, `HUNT_KINDS` from Task 1; `verifyToken` (default export of `src/middleware/auth.middleware.ts`), `validate` from `src/middleware/validate.middleware.ts`.
- Produces HTTP API (all require `Authorization: Bearer <jwt>`):
  - `GET /hunt-reports` → `HuntReportView[]`
  - `POST /hunt-reports` multipart fields `photo` (file), `huntCode`, `huntTime` (ISO), `area`, `kind`, optional `lng`, `lat` → `201 HuntReportView`; `409 { message, reason: "duplicate", reportedByName }`; `400 { message }` or `400 { errors }`
  - `PUT /hunt-reports/:id/submitted` JSON `{ submitted: boolean }` → `HuntReportView`
  - `DELETE /hunt-reports/:id` → `204`
  - `GET /hunt-reports/:id/photo` → image bytes

- [ ] **Step 1: Install multer**

Run: `bun_ add multer@^2.4.0 && bun_ add -d @types/multer@^2.2.0`
Expected: `package.json` and `bun.lock` updated.

- [ ] **Step 2: Upload middleware**

```ts
// src/middleware/photo-upload.middleware.ts
import { NextFunction, Request, Response } from "express";
import multer from "multer";
import { MAX_PHOTO_BYTES, resolvePhotoExtension } from "../services/hunt-report.helpers";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 1 },
  // Disallowed types are dropped (req.file stays undefined) and rejected by the controller with a clear message
  fileFilter: (_req, file, callback) => callback(null, resolvePhotoExtension(file.mimetype) !== null),
});

/** Parse a multipart body with one `photo` file; multer errors become 400 responses. */
export function photoUpload(req: Request, res: Response, next: NextFunction) {
  upload.single("photo")(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError) {
      const message = error.code === "LIMIT_FILE_SIZE" ? "Foto is groter dan 5 MB." : "Foto uploaden is mislukt.";
      return res.status(400).json({ message });
    }
    if (error) return next(error);
    next();
  });
}
```

- [ ] **Step 3: Controller**

```ts
// src/controllers/hunt-reports.controller.ts
import { Request, Response } from "express";
import type { HuntKind } from "../services/hunt-report.helpers";
import {
  createHuntReport,
  deleteHuntReport,
  huntReportPhotoPath,
  HuntReportError,
  listHuntReports,
  setHuntReportSubmitted,
} from "../services/hunt-report.service";

async function respond(res: Response, status: number, action: () => Promise<unknown>) {
  try {
    const result = await action();
    return status === 204 ? res.status(204).end() : res.status(status).json(result);
  } catch (error) {
    if (error instanceof HuntReportError) {
      return res.status(error.status).json({ message: error.message, ...error.details });
    }
    throw error;
  }
}

export function getHuntReports(_req: Request, res: Response) {
  return respond(res, 200, () => listHuntReports());
}

export function postHuntReport(req: Request, res: Response) {
  if (!req.file) return res.status(400).json({ message: "Foto ontbreekt of is geen JPEG, PNG of WebP." });
  const { area, huntCode, huntTime, kind, lng, lat } = req.body as Record<string, string | undefined>;
  const location: [number, number] | undefined = lng !== undefined && lat !== undefined ? [Number(lng), Number(lat)] : undefined;
  return respond(res, 201, () =>
    createHuntReport(
      { area: area!, huntCode: huntCode!, huntTime: new Date(huntTime!), kind: kind as HuntKind, photo: { buffer: req.file!.buffer, mimetype: req.file!.mimetype }, location },
      req.user!,
    ),
  );
}

export function putSubmitted(req: Request, res: Response) {
  return respond(res, 200, () => setHuntReportSubmitted(String(req.params.id), req.body.submitted === true, req.user!));
}

export function deleteReport(req: Request, res: Response) {
  return respond(res, 204, () => deleteHuntReport(String(req.params.id), req.user!));
}

export async function getPhoto(req: Request, res: Response) {
  try {
    const file = await huntReportPhotoPath(String(req.params.id));
    res.setHeader("Cache-Control", "private, max-age=86400");
    return res.sendFile(file);
  } catch (error) {
    if (error instanceof HuntReportError) return res.status(error.status).json({ message: error.message });
    throw error;
  }
}
```

- [ ] **Step 4: Route (auth before the multipart parser, validation after it)**

```ts
// src/routes/hunt-reports.route.ts
import express from "express";
import { body, param } from "express-validator";
import * as huntReportsController from "../controllers/hunt-reports.controller";
import verifyToken from "../middleware/auth.middleware";
import { photoUpload } from "../middleware/photo-upload.middleware";
import { validate } from "../middleware/validate.middleware";
import { HUNT_AREAS, HUNT_KINDS } from "../services/hunt-report.helpers";

const router = express.Router();

const idParam = param("id").isMongoId().withMessage("Ongeldig hunt-ID.");

router.get("/", verifyToken, huntReportsController.getHuntReports);
router.post(
  "/",
  [
    verifyToken,
    photoUpload,
    validate([
      body("huntCode").isString().trim().isLength({ min: 1, max: 64 }).withMessage("Huntcode ontbreekt."),
      body("huntTime").isISO8601().withMessage("Ongeldige tijd."),
      body("area").isIn(HUNT_AREAS).withMessage("Onbekend deelgebied."),
      body("kind").isIn(HUNT_KINDS).withMessage("Soort moet hunt of tegenhunt zijn."),
      body("lng").optional().isFloat({ min: -180, max: 180 }).withMessage("Ongeldige lengtegraad."),
      body("lat").optional().isFloat({ min: -90, max: 90 }).withMessage("Ongeldige breedtegraad."),
    ]),
  ],
  huntReportsController.postHuntReport,
);
router.put(
  "/:id/submitted",
  [verifyToken, validate([idParam, body("submitted").isBoolean({ strict: true }).withMessage("submitted moet true of false zijn.")])],
  huntReportsController.putSubmitted,
);
router.delete("/:id", [verifyToken, validate([idParam])], huntReportsController.deleteReport);
router.get("/:id/photo", [verifyToken, validate([idParam])], huntReportsController.getPhoto);

export default router;
```

- [ ] **Step 5: Mount the route in `src/index.ts`**

Add `import huntReportsRoute from "./routes/hunt-reports.route";` next to the other route imports and `app.use("/hunt-reports", huntReportsRoute);` directly after `app.use("/hunts", huntsRoute);`.

- [ ] **Step 6: Link scraped hunts in `src/crons/jotihunt-scraper.cron.ts`**

Add `import { linkScrapedHunts } from "../services/hunt-report.service";` and, directly after the `Hunt.insertMany(...)` statement inside the `try` block:

```ts
    // Copy status and points to the app's own reports; they keep them after the scraper forgets older hunts
    await linkScrapedHunts(webHunts).catch((error) => {
      logger.error("(CRON) Error linking scraped hunts to hunt reports:", error);
    });
```

- [ ] **Step 7: Ignore uploads, document, add the Docker volume**

- `.gitignore`: add a line `uploads/`. If `.dockerignore` exists, add `uploads`.
- `README.md`: add a short Dutch section "Hunts registreren": hunters registreren een hunt met foto vanaf hun telefoon; foto's staan in de map `uploads` (Docker-volume `uploads`, pad aanpasbaar met `UPLOADS_DIR`); HQ stuurt de hunt zelf in op jotihunt.nl en klikt op "Ingestuurd".
- `/home/silke/Documents/Jotihunt 2026/docker-compose.yml`: under `server:` add
  ```yaml
      volumes:
        - uploads:/usr/src/app/uploads
  ```
  and under the top-level `volumes:` add `  uploads:`.

- [ ] **Step 8: Verify**

Run: `bun_ test`, `bun_ run typecheck`, `bun_ run lint` — all clean.
Then rebuild and smoke-test (log in as the local normal test user; do not print the token):

```bash
cd "/home/silke/Documents/Jotihunt 2026" && docker compose up -d --build server
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' -d '{"email":"solver@local.test","password":"Solver123456"}' | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')
printf '\xff\xd8\xff\xe0test' > /tmp/hunt.jpg
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/hunt-reports                          # 401
curl -s -H "Authorization: Bearer $TOKEN" -F photo=@/tmp/hunt.jpg\;type=image/jpeg -F huntCode='smoke 1' -F huntTime=2026-10-17T12:00:00Z -F area=alpha -F kind=hunt -F lng=5.9 -F lat=52.2 http://localhost:3000/hunt-reports   # 201 JSON, huntCode SMOKE1
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" -F photo=@/tmp/hunt.jpg\;type=image/jpeg -F huntCode=SMOKE1 -F huntTime=2026-10-17T12:00:00Z -F area=alpha -F kind=hunt http://localhost:3000/hunt-reports   # 409
ID=<_id from the 201 response>
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/hunt-reports/$ID/photo                  # 401
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" http://localhost:3000/hunt-reports/$ID/photo   # 200
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" -X DELETE http://localhost:3000/hunt-reports/$ID   # 204
```

The login response is `{ accessToken, user }` (see `src/controllers/auth.controller.ts`).

- [ ] **Step 9: Commit**

```bash
git add package.json bun.lock src/middleware/photo-upload.middleware.ts src/controllers/hunt-reports.controller.ts src/routes/hunt-reports.route.ts src/index.ts src/crons/jotihunt-scraper.cron.ts .gitignore README.md
git add .dockerignore 2>/dev/null || true
git commit -m "feat(hunts): hunt report API with photo upload and scraper link

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Client types, helpers and cooldown from reports

**Files:**
- Create: `src/types/HuntReport.ts`
- Create: `src/lib/hunt-reports.ts`
- Test: `src/lib/hunt-reports.test.ts`
- Modify: `src/lib/fox-status.ts`, `src/lib/fox-status.test.ts`

**Interfaces:**
- Consumes: `Hunt` (`src/types/Hunt.ts`), `Area` (`src/types/Area.ts`), `Prediction` (`src/types/Prediction.ts`), `formatHintCountdown(ms)` from `src/lib/next-hint.ts`.
- Produces:
  - Types `HuntKind`, `HuntReportStatus`, `HuntReport` (mirror of the server `HuntReportView`), `HuntListItem`.
  - `normalizeHuntCode(code: string): string`
  - `extractHuntCode(ocrText: string): string` ('' when nothing found)
  - `resolveHuntTime(hours: number, minutes: number, now: Date): Date`
  - `nearestArea(position: { lng: number; lat: number } | null, predictions: Prediction[] | undefined): string | null`
  - `huntStatusLabel(report: HuntReport): string`
  - `pendingReports(reports: HuntReport[] | undefined): HuntReport[]` (to_submit + overdue)
  - `huntsSummary(reports: HuntReport[] | undefined): string | undefined`
  - `huntListItems(reports: HuntReport[] | undefined, hunts: Hunt[] | undefined): HuntListItem[]`
  - `formatHuntTime(iso: string): string` (`HH:MM`, nl-NL)
  - `fox-status.ts`: `lastHuntTimeFor(hunts, areaName, reports?)` and `cooldownSummary(areas, hunts, now, reports?)` now also consider reports of kind `hunt`.

- [ ] **Step 1: Types**

```ts
// src/types/HuntReport.ts
export type HuntKind = 'hunt' | 'tegenhunt';
export type HuntReportStatus = 'to_submit' | 'overdue' | 'submitted' | 'judged';

export interface HuntReport {
  _id: string;
  area: string;
  huntCode: string;
  /** ISO */
  huntTime: string;
  kind: HuntKind;
  reportedBy: string;
  reportedByName: string;
  submittedAt: string | null;
  submittedByName: string | null;
  /** Last result on jotihunt.nl (raw status text from the site) */
  site: { status: string; points: number; seenAt: string } | null;
  createdAt: string;
  status: HuntReportStatus;
  /** ISO: huntTime + 30 min */
  deadline: string;
  /** Server path of the photo; needs the auth header */
  photoUrl: string;
}

/** A row in "Alle hunts": an own report, or a scraped jotihunt.nl hunt that nobody registered in the app. */
export type HuntListItem = { source: 'app'; report: HuntReport } | { source: 'website'; hunt: import('./Hunt').Hunt };
```

- [ ] **Step 2: Write the failing tests**

```ts
// src/lib/hunt-reports.test.ts
import { describe, expect, test } from 'bun:test';
import type { Hunt } from '@/types/Hunt';
import type { HuntReport } from '@/types/HuntReport';
import type { Prediction } from '@/types/Prediction';
import { extractHuntCode, huntListItems, huntsSummary, huntStatusLabel, nearestArea, normalizeHuntCode, pendingReports, resolveHuntTime } from './hunt-reports';

function report(overrides: Partial<HuntReport> = {}): HuntReport {
  return {
    _id: 'r1',
    area: 'alpha',
    huntCode: 'AB12CD',
    huntTime: '2026-10-17T12:00:00.000Z',
    kind: 'hunt',
    reportedBy: 'u1',
    reportedByName: 'Merida',
    submittedAt: null,
    submittedByName: null,
    site: null,
    createdAt: '2026-10-17T12:05:00.000Z',
    status: 'to_submit',
    deadline: '2026-10-17T12:30:00.000Z',
    photoUrl: '/hunt-reports/r1/photo',
    ...overrides,
  };
}

function prediction(area: string, lng: number, lat: number): Prediction {
  return { area, lastObservation: { time: '2026-10-17T11:00:00Z', lng, lat, kind: 'hint' } } as Prediction;
}

describe('normalizeHuntCode', () => {
  test('removes whitespace and uppercases', () => expect(normalizeHuntCode(' ab 12 ')).toBe('AB12'));
});

describe('extractHuntCode', () => {
  test('picks the longest alphanumeric token of 4+ characters', () => {
    expect(extractHuntCode('JOTIHUNT 2026\nCode: K7X9QP2\nAlpha')).toBe('K7X9QP2');
  });
  test('uppercases and ignores punctuation around the code', () => {
    expect(extractHuntCode('code:\n  "k7x9qp"')).toBe('K7X9QP');
  });
  test('empty when there is no token of 4+ characters', () => {
    expect(extractHuntCode('ab 12 x')).toBe('');
    expect(extractHuntCode('')).toBe('');
  });
});

describe('resolveHuntTime', () => {
  const now = new Date(2026, 9, 17, 14, 10); // local time
  test('today when the time is not in the future', () => {
    expect(resolveHuntTime(13, 55, now)).toEqual(new Date(2026, 9, 17, 13, 55));
  });
  test('allows up to 5 minutes in the future (clock differences)', () => {
    expect(resolveHuntTime(14, 15, now)).toEqual(new Date(2026, 9, 17, 14, 15));
  });
  test('yesterday when more than 5 minutes in the future (hunt runs through the night)', () => {
    expect(resolveHuntTime(23, 55, new Date(2026, 9, 18, 0, 10))).toEqual(new Date(2026, 9, 17, 23, 55));
  });
});

describe('nearestArea', () => {
  const predictions = [prediction('alpha', 5.9, 52.2), prediction('bravo', 6.1, 52.0)];
  test('area of the nearest last observation', () => {
    expect(nearestArea({ lng: 6.09, lat: 52.01 }, predictions)).toBe('bravo');
  });
  test('null without position or observations', () => {
    expect(nearestArea(null, predictions)).toBeNull();
    expect(nearestArea({ lng: 6, lat: 52 }, [{ area: 'alpha', lastObservation: null } as Prediction])).toBeNull();
  });
});

describe('huntStatusLabel', () => {
  test('Dutch labels, raw site status when judged', () => {
    expect(huntStatusLabel(report())).toBe('Te versturen');
    expect(huntStatusLabel(report({ status: 'overdue' }))).toBe('Te laat!');
    expect(huntStatusLabel(report({ status: 'submitted' }))).toBe('Ingestuurd');
    expect(huntStatusLabel(report({ status: 'judged', site: { status: 'Goedgekeurd', points: 5, seenAt: '' } }))).toBe('Goedgekeurd');
  });
});

describe('pendingReports / huntsSummary', () => {
  test('pending = to_submit + overdue', () => {
    const reports = [report(), report({ _id: 'r2', status: 'overdue' }), report({ _id: 'r3', status: 'submitted' })];
    expect(pendingReports(reports).map((r) => r._id)).toEqual(['r1', 'r2']);
    expect(huntsSummary(reports)).toBe('2 te versturen');
  });
  test('count and points when nothing is pending', () => {
    const reports = [report({ status: 'judged', site: { status: 'Goedgekeurd', points: 5, seenAt: '' } }), report({ _id: 'r2', status: 'submitted' })];
    expect(huntsSummary(reports)).toBe('2 hunts · 5 pt');
  });
  test('undefined while loading', () => expect(huntsSummary(undefined)).toBeUndefined());
});

describe('huntListItems', () => {
  test('adds scraped hunts whose code matches no report', () => {
    const hunts = [
      { _id: 'h1', area: 'Alpha', huntCode: 'ab12cd', status: 'Goedgekeurd', points: 5, huntTime: new Date(), updatedAt: new Date() },
      { _id: 'h2', area: 'Bravo', huntCode: 'ZZ99', status: 'Afgekeurd', points: 0, huntTime: new Date(), updatedAt: new Date() },
    ] as Hunt[];
    const items = huntListItems([report()], hunts);
    expect(items.map((item) => item.source)).toEqual(['app', 'website']);
    expect(items[1].source === 'website' && items[1].hunt.huntCode).toBe('ZZ99');
  });
});
```

Also append to `src/lib/fox-status.test.ts`:

```ts
describe('lastHuntTimeFor with reports', () => {
  test('a registered hunt starts the cooldown before the scraper sees it', () => {
    const reports = [{ area: 'alpha', kind: 'hunt', huntTime: '2026-10-17T13:00:00Z' }] as HuntReport[];
    const hunts = [hunt('Alpha', 'Goedgekeurd', '2026-10-17T11:00:00Z')];
    expect(new Date(lastHuntTimeFor(hunts, 'Alpha', reports)!).toISOString()).toBe('2026-10-17T13:00:00.000Z');
  });
  test('registered tegenhunts do not count', () => {
    const reports = [{ area: 'alpha', kind: 'tegenhunt', huntTime: '2026-10-17T13:00:00Z' }] as HuntReport[];
    expect(lastHuntTimeFor(undefined, 'Alpha', reports)).toBeUndefined();
  });
});
```

(add `import type { HuntReport } from '@/types/HuntReport';` at the top of that file).

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun_ test src/lib/hunt-reports.test.ts src/lib/fox-status.test.ts`
Expected: FAIL (module `./hunt-reports` missing; fox-status reports test fails).

- [ ] **Step 4: Implement `src/lib/hunt-reports.ts`**

```ts
import { distance } from '@turf/turf';
import type { Hunt } from '@/types/Hunt';
import type { HuntListItem, HuntReport } from '@/types/HuntReport';
import type { Prediction } from '@/types/Prediction';

/** Same rule as the server: no whitespace, uppercase. */
export function normalizeHuntCode(code: string): string {
  return code.replace(/\s+/g, '').toUpperCase();
}

/** The hunt code in OCR text: the longest alphanumeric token of at least 4 characters ('' when none). */
export function extractHuntCode(ocrText: string): string {
  const tokens = ocrText.toUpperCase().match(/[A-Z0-9]{4,}/g) ?? [];
  return tokens.reduce((longest, token) => (token.length > longest.length ? token : longest), '');
}

const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * The most recent occurrence of HH:MM (local time). More than 5 minutes in the future means yesterday:
 * the hunt runs through the night, so 23:55 registered at 00:10 is last night.
 */
export function resolveHuntTime(hours: number, minutes: number, now: Date): Date {
  const time = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
  if (time.getTime() - now.getTime() > FUTURE_TOLERANCE_MS) time.setDate(time.getDate() - 1);
  return time;
}

/** Area whose last observation (hint/hunt/spot) is closest to the phone, or null. */
export function nearestArea(position: { lng: number; lat: number } | null, predictions: Prediction[] | undefined): string | null {
  if (!position || !predictions) return null;
  let best: { area: string; km: number } | null = null;
  for (const prediction of predictions) {
    const observation = prediction.lastObservation;
    if (!observation) continue;
    const km = distance([position.lng, position.lat], [observation.lng, observation.lat]);
    if (!best || km < best.km) best = { area: prediction.area, km };
  }
  return best?.area ?? null;
}

export function huntStatusLabel(report: HuntReport): string {
  switch (report.status) {
    case 'to_submit':
      return 'Te versturen';
    case 'overdue':
      return 'Te laat!';
    case 'submitted':
      return 'Ingestuurd';
    case 'judged':
      return report.site?.status || 'Beoordeeld';
  }
}

/** Reports HQ still has to submit on jotihunt.nl. */
export function pendingReports(reports: HuntReport[] | undefined): HuntReport[] {
  return (reports ?? []).filter((report) => report.status === 'to_submit' || report.status === 'overdue');
}

/** Collapsed sidebar summary: "2 te versturen", or "5 hunts · 42 pt". */
export function huntsSummary(reports: HuntReport[] | undefined): string | undefined {
  if (!reports) return undefined;
  const pending = pendingReports(reports).length;
  if (pending) return `${pending} te versturen`;
  const points = reports.reduce((sum, report) => sum + (report.site?.points ?? 0), 0);
  return `${reports.length} hunts · ${points} pt`;
}

/** Own reports plus scraped jotihunt.nl hunts that match no report (by normalised code). */
export function huntListItems(reports: HuntReport[] | undefined, hunts: Hunt[] | undefined): HuntListItem[] {
  const codes = new Set((reports ?? []).map((report) => report.huntCode));
  const websiteOnly = (hunts ?? []).filter((hunt) => hunt.huntCode && !codes.has(normalizeHuntCode(hunt.huntCode)));
  return [...(reports ?? []).map((report) => ({ source: 'app' as const, report })), ...websiteOnly.map((hunt) => ({ source: 'website' as const, hunt }))];
}

/** "14:05" in Dutch 24 h time. */
export function formatHuntTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}
```

- [ ] **Step 5: Update `src/lib/fox-status.ts`**

Replace `lastHuntTimeFor` and `cooldownSummary` with (keep the other functions unchanged; add `import type { HuntReport } from '@/types/HuntReport';`):

```ts
/**
 * Time of the latest hunt on an area, from the scraped jotihunt.nl hunts and the app's own reports (so the
 * cooldown starts at registration). Tegenhunts don't count for the cooldown (since 2024).
 */
export function lastHuntTimeFor(hunts: Hunt[] | undefined, areaName: string, reports?: HuntReport[]): Date | string | undefined {
  const area = areaName.toLowerCase();
  const times: (Date | string)[] = [
    ...(hunts ?? []).filter((hunt) => !hunt.status.toLowerCase().includes('tegenhunt') && hunt.area.toLowerCase() === area).map((hunt) => hunt.huntTime),
    ...(reports ?? []).filter((report) => report.kind === 'hunt' && report.area === area).map((report) => report.huntTime),
  ];
  return times
    .filter((time) => !Number.isNaN(new Date(time).getTime()))
    .reduce<Date | string | undefined>((latest, time) => (!latest || new Date(time).getTime() > new Date(latest).getTime() ? time : latest), undefined);
}
```

and in `cooldownSummary` add a fourth parameter `reports?: HuntReport[]` and pass it: `huntCooldownMs(lastHuntTimeFor(hunts, area.name, reports), now)`.

Note: the old implementation returned the first matching hunt without checking the date; the new one ignores unparseable site times (they could not produce a cooldown anyway — `huntCooldownMs` on an invalid date returned `NaN`). Run the existing fox-status tests to confirm nothing else changed.

- [ ] **Step 6: Run tests**

Run: `bun_ test` → all PASS. `bun_ run lint` → clean.

- [ ] **Step 7: Commit**

```bash
git add src/types/HuntReport.ts src/lib/hunt-reports.ts src/lib/hunt-reports.test.ts src/lib/fox-status.ts src/lib/fox-status.test.ts
git commit -m "feat(hunts): hunt report types, helpers and cooldown from registered hunts

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Client data layer — hook, authenticated images, downscaling, OCR, capture store

**Files:**
- Modify: `package.json` (add `tesseract.js@^7.0.0`)
- Create: `src/hooks/hunt-reports.hook.ts`
- Create: `src/hooks/auth-image.hook.ts`
- Create: `src/lib/image.ts`
- Create: `src/lib/ocr.ts`
- Create: `src/stores/hunt-capture.store.ts`

**Interfaces:**
- Consumes: `fetcherWithMethod`, `useAuthSWR` from `src/lib/swr.ts`; `extractHuntCode` (Task 4); types from Task 4.
- Produces:
  - `useHuntReports(): { reports: HuntReport[] | undefined; isError: boolean; createReport(input: NewReportInput): Promise<HuntReport>; setSubmitted(id: string, submitted: boolean): Promise<HuntReport>; deleteReport(id: string): Promise<void> }`
  - `interface NewReportInput { photo: Blob; huntCode: string; huntTime: Date; area: string; kind: HuntKind; position: { lng: number; lat: number } | null }`
  - `useAuthImage(path: string | null): string | undefined` (object URL, revoked on change/unmount)
  - `downscalePhoto(file: Blob, maxSide?: number): Promise<Blob>` (JPEG 0.8, default 1600)
  - `readHuntCode(image: Blob): Promise<string>` ('' on failure)
  - `useHuntCaptureStore`: `{ photo: File | null; open: boolean; startCapture(photo: File): void; close(): void }`

- [ ] **Step 1: Install tesseract.js**

Run: `bun_ add tesseract.js@^7.0.0`

- [ ] **Step 2: Hook**

```ts
// src/hooks/hunt-reports.hook.ts
import axios from 'axios';
import useAuthHeader from 'react-auth-kit/hooks/useAuthHeader';
import { fetcherWithMethod, useAuthSWR } from '@/lib/swr';
import type { HuntKind, HuntReport } from '@/types/HuntReport';

const HUNT_REPORTS_REFRESH_MS = 10_000;

export interface NewReportInput {
  photo: Blob;
  huntCode: string;
  huntTime: Date;
  area: string;
  kind: HuntKind;
  position: { lng: number; lat: number } | null;
}

export const useHuntReports = () => {
  const authHeader = useAuthHeader() || '';
  const { data, error, mutate } = useAuthSWR<HuntReport[]>('/hunt-reports', { refreshInterval: HUNT_REPORTS_REFRESH_MS });

  /** Upload a new report (multipart). Throws the axios error on failure (409 = duplicate code). */
  async function createReport(input: NewReportInput): Promise<HuntReport> {
    const form = new FormData();
    form.append('photo', input.photo, 'hunt.jpg');
    form.append('huntCode', input.huntCode);
    form.append('huntTime', input.huntTime.toISOString());
    form.append('area', input.area);
    form.append('kind', input.kind);
    if (input.position) {
      form.append('lng', String(input.position.lng));
      form.append('lat', String(input.position.lat));
    }
    const response = await axios.post<HuntReport>(`${import.meta.env.API_BASE_URL}/hunt-reports`, form, { headers: { Authorization: authHeader } });
    await mutate((current) => [response.data, ...(current ?? [])], { revalidate: true });
    return response.data;
  }

  async function setSubmitted(id: string, submitted: boolean): Promise<HuntReport> {
    const report = (await fetcherWithMethod(`/hunt-reports/${id}/submitted`, authHeader, 'PUT', { submitted })) as HuntReport;
    await mutate((current) => (current ?? []).map((existing) => (existing._id === id ? report : existing)), { revalidate: false });
    return report;
  }

  async function deleteReport(id: string): Promise<void> {
    await fetcherWithMethod(`/hunt-reports/${id}`, authHeader, 'DELETE');
    await mutate((current) => (current ?? []).filter((existing) => existing._id !== id), { revalidate: false });
  }

  return { reports: data, isError: !!error, createReport, setSubmitted, deleteReport };
};
```

- [ ] **Step 3: Authenticated image hook**

```ts
// src/hooks/auth-image.hook.ts
import { useEffect, useState } from 'react';
import axios from 'axios';
import useAuthHeader from 'react-auth-kit/hooks/useAuthHeader';

/**
 * Load an image from the API with the auth header (an <img src> can't send it) and return an object URL.
 * The URL is revoked when the path changes or the component unmounts.
 */
export function useAuthImage(path: string | null): string | undefined {
  const authHeader = useAuthHeader() || '';
  const [image, setImage] = useState<{ path: string; url: string } | undefined>(undefined);

  useEffect(() => {
    if (!path) return;
    let objectUrl: string | undefined;
    let cancelled = false;
    axios
      .get<Blob>(`${import.meta.env.API_BASE_URL}${path}`, { headers: { Authorization: authHeader }, responseType: 'blob' })
      .then((response) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(response.data);
        setImage({ path, url: objectUrl });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, authHeader]);

  return image && image.path === path ? image.url : undefined;
}
```

- [ ] **Step 4: Downscaling**

```ts
// src/lib/image.ts
/**
 * Downscale a photo to at most `maxSide` px on the long side and re-encode it as JPEG (quality 0.8).
 * Phone photos are 3–8 MB; this keeps uploads around 300 KB on a bad connection and speeds up OCR.
 * Uses the EXIF orientation (createImageBitmap `imageOrientation: 'from-image'`).
 */
export async function downscalePhoto(file: Blob, maxSide = 1600): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Foto verkleinen mislukt'))), 'image/jpeg', 0.8));
}
```

- [ ] **Step 5: OCR**

```ts
// src/lib/ocr.ts
import type { Worker } from 'tesseract.js';
import { extractHuntCode } from './hunt-reports';

let workerPromise: Promise<Worker> | null = null;

/**
 * One shared Tesseract worker, created on first use (loads the wasm core and the `eng` data, cached by the
 * browser afterwards). Recognition runs in the browser: the photo never leaves the device for OCR.
 */
function getWorker(): Promise<Worker> {
  workerPromise ??= import('tesseract.js').then(async ({ createWorker }) => {
    const worker = await createWorker('eng');
    await worker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' });
    return worker;
  });
  workerPromise.catch(() => {
    workerPromise = null;
  });
  return workerPromise;
}

/** Read the hunt code from a photo; '' when OCR fails or finds nothing. */
export async function readHuntCode(image: Blob): Promise<string> {
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(image);
    return extractHuntCode(data.text);
  } catch {
    return '';
  }
}
```

Note: the whitelist has no spaces, so Tesseract may join words; `extractHuntCode` still picks the longest token. If testing in Task 9 shows joined tokens hurt, add `' '` to the whitelist (Tesseract then keeps word gaps).

- [ ] **Step 6: Capture store**

```ts
// src/stores/hunt-capture.store.ts
import { create } from 'zustand';

interface HuntCaptureState {
  /** Photo waiting to be registered */
  photo: File | null;
  open: boolean;
  startCapture: (photo: File) => void;
  close: () => void;
}

/** Shared between the camera button / sidebar button (which pick a photo) and the registration dialog. */
const useHuntCaptureStore = create<HuntCaptureState>()((set) => ({
  photo: null,
  open: false,
  startCapture: (photo) => set({ photo, open: true }),
  close: () => set({ open: false, photo: null }),
}));

export default useHuntCaptureStore;
```

- [ ] **Step 7: Verify and commit**

Run: `bun_ run build` and `bun_ run lint` → clean.

```bash
git add package.json bun.lock src/hooks/hunt-reports.hook.ts src/hooks/auth-image.hook.ts src/lib/image.ts src/lib/ocr.ts src/stores/hunt-capture.store.ts
git commit -m "feat(hunts): hunt report hook, authenticated images, photo downscaling and OCR

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Registration dialog, photo input and mobile camera button

**Files:**
- Create: `src/components/hunts/HuntPhotoInput.tsx`
- Create: `src/components/hunts/HuntCaptureButton.tsx`
- Create: `src/components/hunts/HuntRegistrationDialog.tsx`
- Modify: `src/pages/App.tsx`

**Interfaces:**
- Consumes: `useHuntCaptureStore`, `useHuntReports`, `downscalePhoto`, `readHuntCode`, `resolveHuntTime`, `nearestArea`, `normalizeHuntCode`, `lastHuntTimeFor`, `huntCooldownMs` (fox-status), `useAreas` (`src/hooks/areas.hook.ts`, returns `{ areas }`), `useHunts`, `usePredictions`, `useIsMobile`, `areaOptions` + `getColorFromArea` from `src/lib/utils.ts`, shadcn `Dialog*`, `Button`, `Input`, `Field*`, `ToggleGroup*`.
- Produces:
  - `<HuntPhotoInput capture={boolean}>{(open: () => void) => ReactNode}</HuntPhotoInput>` — renders a hidden file input and gives its children a function to open it; on change calls `startCapture(file)`.
  - `<HuntCaptureButton />` — mobile floating camera button.
  - `<HuntRegistrationDialog />` — mounted once in `App.tsx`, driven by the capture store.

- [ ] **Step 1: Photo input**

```tsx
// src/components/hunts/HuntPhotoInput.tsx
import { ReactNode, useRef } from 'react';
import useHuntCaptureStore from '@/stores/hunt-capture.store';

/**
 * Hidden file input for a hunt photo. With `capture` the phone opens the rear camera directly; without it
 * (desktop) a file picker opens. The chosen photo goes to the capture store, which opens the registration dialog.
 */
export default function HuntPhotoInput({ capture, children }: { capture: boolean; children: (open: () => void) => ReactNode }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const startCapture = useHuntCaptureStore((state) => state.startCapture);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture={capture ? 'environment' : undefined}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) startCapture(file);
        }}
      />
      {children(() => inputRef.current?.click())}
    </>
  );
}
```

- [ ] **Step 2: Mobile camera button**

```tsx
// src/components/hunts/HuntCaptureButton.tsx
import { CameraIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import HuntPhotoInput from './HuntPhotoInput';

/**
 * Phones: round camera button at the bottom right, just above the bottom sheet's peek height (200 px).
 * z-30 keeps it under the sheet (z-40) when the sheet is pulled up.
 */
export default function HuntCaptureButton() {
  return (
    <HuntPhotoInput capture>
      {(open) => (
        <Button size="icon-lg" className="fixed bottom-[212px] right-3 z-30 size-14 rounded-full shadow-lg" onClick={open} aria-label="Hunt registreren">
          <CameraIcon className="size-6" />
        </Button>
      )}
    </HuntPhotoInput>
  );
}
```

- [ ] **Step 3: Registration dialog**

Behaviour (all copy Dutch):
- Opens when `useHuntCaptureStore().open` is true. On open with a new photo: downscale (`downscalePhoto`), show the preview from an object URL, then run `readHuntCode` on the downscaled blob; while running show "Code lezen…" with a spinner next to the code field; afterwards fill the code field when it is still empty and show "Controleer de code" (found) or "Code niet gelezen, typ hem over" (not found). Ask for the position once (`navigator.geolocation.getCurrentPosition`, `enableHighAccuracy: true`, `timeout: 10000`, `maximumAge: 60000`), and preselect `nearestArea(position, predictions)` when the user has not picked an area yet.
- Fields: code (`Input`, `autoCapitalize="characters"`, value shown normalised with `normalizeHuntCode` on blur), area (`ToggleGroup type="single"` of `areaOptions`, each item with a colour dot from `getColorFromArea`), time (two `Input`s `inputMode="numeric"` maxLength 2 for HH and MM, auto-advance to MM after 2 digits, plus "Nu" button that fills the current local time), kind (`ToggleGroup`: Hunt / Tegenhunt, default hunt). Below the time: "Hunt om 23:55 op vr 17 okt" from `resolveHuntTime(hh, mm, new Date())` formatted with `toLocaleString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })`.
- Validation before save: code non-empty, area chosen, HH 0–23 and MM 0–59. Show field errors via `FieldError`.
- Non-blocking warning (amber text) when the chosen area's status is `red` ("Deze vos is inactief (rood). De hunt wordt waarschijnlijk afgekeurd.") or `huntCooldownMs(lastHuntTimeFor(hunts, area, reports), Date.now()) > 0` for kind `hunt` ("Deze vos zit nog in de cooldown van een eerdere hunt.").
- Save: `createReport({ photo: downscaled, huntCode: normalizeHuntCode(code), huntTime: resolveHuntTime(...), area, kind, position })`. On success: `toast.success('Hunt geregistreerd', { description: 'HQ heeft tot HH:MM om hem in te sturen.' })` using `formatHuntTime(report.deadline)`, then `close()`. On axios 409: field error "Deze code is al geregistreerd door {reportedByName}". On other errors: keep the dialog and all data, show an inline destructive message "Opslaan is mislukt. Controleer je verbinding." and the save button reads "Opnieuw proberen".
- Closing the dialog (X / Escape) calls `close()`; the object URL is revoked.
- Layout: `DialogContent` with `className="max-h-[92dvh] overflow-y-auto sm:max-w-md"`; photo preview `max-h-48 w-full rounded-md object-contain bg-muted`.

Implementation skeleton (fill in exactly per the behaviour above):

```tsx
// src/components/hunts/HuntRegistrationDialog.tsx
import { useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import { Loader2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useAreas } from '@/hooks/areas.hook';
import { useHunts } from '@/hooks/hunts.hook';
import { useHuntReports } from '@/hooks/hunt-reports.hook';
import { usePredictions } from '@/hooks/predictions.hook';
import { huntCooldownMs, lastHuntTimeFor } from '@/lib/fox-status';
import { formatHuntTime, nearestArea, normalizeHuntCode, resolveHuntTime } from '@/lib/hunt-reports';
import { downscalePhoto } from '@/lib/image';
import { readHuntCode } from '@/lib/ocr';
import { areaOptions, getColorFromArea } from '@/lib/utils';
import useHuntCaptureStore from '@/stores/hunt-capture.store';
import type { HuntKind } from '@/types/HuntReport';

type OcrState = 'idle' | 'reading' | 'found' | 'not_found';

export default function HuntRegistrationDialog() {
  const { photo, open, close } = useHuntCaptureStore();
  const { areas } = useAreas();
  const { hunts } = useHunts();
  const { predictions } = usePredictions();
  const { reports, createReport } = useHuntReports();

  const [prepared, setPrepared] = useState<{ source: File; blob: Blob; url: string } | null>(null);
  const [ocr, setOcr] = useState<OcrState>('idle');
  const [code, setCode] = useState('');
  const [area, setArea] = useState('');
  const [hours, setHours] = useState('');
  const [minutes, setMinutes] = useState('');
  const [kind, setKind] = useState<HuntKind>('hunt');
  const [position, setPosition] = useState<{ lng: number; lat: number } | null>(null);
  const [errors, setErrors] = useState<{ code?: string; area?: string; time?: string; save?: string }>({});
  const [saving, setSaving] = useState(false);
  const minutesRef = useRef<HTMLInputElement>(null);

  // Reset the form when a new photo arrives (adjust state during render, no effect)
  const [prevPhoto, setPrevPhoto] = useState<File | null>(null);
  if (photo !== prevPhoto) {
    setPrevPhoto(photo);
    setPrepared(null);
    setOcr(photo ? 'reading' : 'idle');
    setCode('');
    setArea('');
    setHours('');
    setMinutes('');
    setKind('hunt');
    setErrors({});
  }

  // Downscale + OCR + position for the new photo (all setState calls happen in async callbacks)
  useEffect(() => {
    if (!photo) return;
    let cancelled = false;
    let url: string | undefined;
    void downscalePhoto(photo)
      .catch(() => photo as Blob)
      .then(async (blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setPrepared({ source: photo, blob, url });
        const found = await readHuntCode(blob);
        if (cancelled) return;
        setCode((current) => current || found);
        setOcr(found ? 'found' : 'not_found');
      });
    navigator.geolocation?.getCurrentPosition(
      (result) => !cancelled && setPosition({ lng: result.coords.longitude, lat: result.coords.latitude }),
      () => undefined,
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [photo]);

  const suggestedArea = nearestArea(position, predictions);
  const chosenArea = area || suggestedArea || '';
  // ... validation, warnings, save handler and JSX per the behaviour list above
}
```

The `chosenArea` derivation replaces "preselect": the suggested area is shown selected until the user picks one. The skeleton's `// ...` must be replaced by the full implementation of the listed behaviour; keep the component under ~250 lines by extracting a small `TimeFields` component inside the same file if needed.

- [ ] **Step 4: Mount in `src/pages/App.tsx`**

Add imports and render, after `<Sidebar mapRef={mapRef} />`:

```tsx
      {isMobile && <HuntCaptureButton />}
      <HuntRegistrationDialog />
```

with `const isMobile = useIsMobile();` (from `@/hooks/media.hook`) inside `App`.

- [ ] **Step 5: Verify and commit**

Run: `bun_ run build`, `bun_ run lint`, `bun_ test` → clean.

```bash
git add src/components/hunts/HuntPhotoInput.tsx src/components/hunts/HuntCaptureButton.tsx src/components/hunts/HuntRegistrationDialog.tsx src/pages/App.tsx
git commit -m "feat(hunts): hunt registration dialog with OCR and mobile camera button

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Sidebar "Hunts" section, status badge, new-report toasts, cooldown in fox pills

**Files:**
- Create: `src/components/hunts/HuntStatusBadge.tsx`
- Create: `src/components/hunts/HuntReportRow.tsx`
- Create: `src/components/hunts/HuntsSection.tsx`
- Create: `src/components/hunts/NewHuntToaster.tsx`
- Modify: `src/stores/sidebar.store.ts` (id `hunts`, default open `true`)
- Modify: `src/components/sidebar/SidebarSections.tsx` (render `<HuntsSection />` directly after the "Hints" section)
- Modify: `src/components/sidebar/FoxPills.tsx` (pass reports to the cooldown helpers)
- Modify: `src/pages/App.tsx` (mount `<NewHuntToaster />`)

**Interfaces:**
- Consumes: Tasks 4–6.
- Produces:
  - `<HuntStatusBadge report={HuntReport} now={number} />` — badge with label + countdown while `to_submit`.
  - `<HuntReportRow report={HuntReport} now={number} />` — compact row with actions.
  - `<HuntsSection />` — sidebar section; owns the "Alle hunts" dialog open state (dialog built in Task 8; until then the button can be rendered disabled — Task 8 wires it).
  - `<NewHuntToaster />` — renders nothing; toasts new reports from others.
  - Ticking clock: use the same pattern as `FoxPills.tsx` — `const [now, setNow] = useState(() => Date.now()); useInterval(() => setNow(Date.now()), 1000);` with `useInterval` from `src/hooks/utils/interval.hook.ts`. Components below that say `useNow()` mean this pattern.

- [ ] **Step 1: Status badge**

Colours: `to_submit` amber (`border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300`), `overdue` destructive (`variant="destructive"`), `submitted` blue (`border-blue-200 bg-blue-100 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/15 dark:text-blue-300`), `judged` green (same muted green classes as the tracker "Verbonden" badge) with `· {points} pt`. `to_submit` shows `Te versturen · {formatHintCountdown(deadline - now)}`.

```tsx
// src/components/hunts/HuntStatusBadge.tsx
import { Badge } from '@/components/ui/badge';
import { huntStatusLabel } from '@/lib/hunt-reports';
import { formatHintCountdown } from '@/lib/next-hint';
import type { HuntReport } from '@/types/HuntReport';

const STATUS_CLASSES: Record<HuntReport['status'], string> = {
  to_submit: 'border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300',
  overdue: '',
  submitted: 'border-blue-200 bg-blue-100 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/15 dark:text-blue-300',
  judged: 'border-green-200 bg-green-100 text-green-700 dark:border-green-500/30 dark:bg-green-500/15 dark:text-green-400',
};

export default function HuntStatusBadge({ report, now }: { report: HuntReport; now: number }) {
  // The server status is from the last poll; flip to overdue locally when the deadline passes in between
  const overdue = report.status === 'to_submit' && new Date(report.deadline).getTime() < now;
  if (overdue || report.status === 'overdue') return <Badge variant="destructive">Te laat!</Badge>;
  let text = huntStatusLabel(report);
  if (report.status === 'to_submit') text += ` · ${formatHintCountdown(new Date(report.deadline).getTime() - now)}`;
  if (report.status === 'judged' && report.site) text += ` · ${report.site.points} pt`;
  return <Badge className={STATUS_CLASSES[report.status]}>{text}</Badge>;
}
```

- [ ] **Step 2: Report row**

Row layout (one line, `text-xs`): area colour dot (`getColorFromArea(report.area)`), code in `font-mono font-medium`, `formatHuntTime(report.huntTime)`, `Tegenhunt` muted label when kind is tegenhunt, then `HuntStatusBadge` right-aligned. When status is `to_submit` or `overdue`, a second line with two `size="xs"` buttons: "Kopieer code" (`navigator.clipboard.writeText(report.huntCode)`, toast "Code gekopieerd") and "Ingestuurd" (calls `setSubmitted(id, true)`, then `toast.success('Gemarkeerd als ingestuurd', { action: { label: 'Ongedaan maken', onClick: () => setSubmitted(id, false) } })`; on failure `toast.error('Opslaan is mislukt')`). Optional `onSelect?: () => void` prop makes the row clickable (used by Task 8 to open the detail).

- [ ] **Step 3: Section**

```tsx
// src/components/hunts/HuntsSection.tsx (structure)
// - const { reports } = useHuntReports(); const now = useNow();
// - summary: pending count > 0 → <Badge variant="destructive">{huntsSummary(reports)}</Badge>, else huntsSummary(reports)
// - <SidebarSection id="hunts" title="Hunts" summary={summary}>
//     <HuntPhotoInput capture={isMobile}>{(open) => <Button size="sm" className="w-full" onClick={open}><CameraIcon data-icon="inline-start" />Hunt registreren</Button>}</HuntPhotoInput>
//     reports?.slice(0, 3).map(report => <HuntReportRow key=... report now onSelect={() => openAll(report._id)} />)
//     empty state (muted): "Nog geen hunts geregistreerd."
//     <Button variant="ghost" size="sm" className="w-full" onClick={() => openAll()}>Alle hunts bekijken</Button>
//   </SidebarSection>
//   <AllHuntsDialog open={allOpen} onOpenChange={setAllOpen} initialReportId={selectedId} />   (added in Task 8)
```

Add `'hunts'` to `SidebarSectionId` and `hunts: true` to `DEFAULT_OPEN_SECTIONS` in `src/stores/sidebar.store.ts` (the existing merge picks up the new default for users with persisted state).

- [ ] **Step 4: New-report toaster**

```tsx
// src/components/hunts/NewHuntToaster.tsx
import { useState } from 'react';
import { toast } from 'sonner';
import useAuthUser from 'react-auth-kit/hooks/useAuthUser';
import { useHuntReports } from '@/hooks/hunt-reports.hook';
import { formatHintCountdown } from '@/lib/next-hint';
import { capitalizeFirstLetter } from '@/lib/utils';
import type { User } from '@/types/User';

/**
 * Toast every user when someone else registers a hunt: "Nieuwe hunt Alpha – nog 27:00 om in te sturen".
 * The first load only records the known ids (no toasts for existing reports).
 */
export default function NewHuntToaster() {
  const user = useAuthUser<User>();
  const { reports } = useHuntReports();
  const [known, setKnown] = useState<Set<string> | null>(null);

  if (reports) {
    const ids = new Set(reports.map((report) => report._id));
    const fresh = known ? reports.filter((report) => !known.has(report._id)) : [];
    if (!known || fresh.length || ids.size !== known.size) {
      setKnown(ids);
      for (const report of fresh) {
        if (report.reportedBy === user?._id) continue;
        const left = new Date(report.deadline).getTime() - Date.now();
        // Deferred: sonner's toast() updates its own store and must not run during this component's render
        setTimeout(() =>
          toast.info(`Nieuwe ${report.kind === 'tegenhunt' ? 'tegenhunt' : 'hunt'} ${capitalizeFirstLetter(report.area)}`, {
            description: left > 0 ? `Door ${report.reportedByName} – nog ${formatHintCountdown(left)} om in te sturen.` : `Door ${report.reportedByName}.`,
          }),
        );
      }
    }
  }
  return null;
}
```

Mount `<NewHuntToaster />` in `src/pages/App.tsx`.

- [ ] **Step 5: Fox pills cooldown**

In `src/components/sidebar/FoxPills.tsx`: `const { reports } = useHuntReports();` and pass `reports` as the extra argument to `cooldownSummary(areas, hunts, now, reports)` and `lastHuntTimeFor(hunts, area.name, reports)`.

- [ ] **Step 6: Verify and commit**

Run: `bun_ test`, `bun_ run build`, `bun_ run lint` → clean.

```bash
git add src/components/hunts src/stores/sidebar.store.ts src/components/sidebar/SidebarSections.tsx src/components/sidebar/FoxPills.tsx src/pages/App.tsx
git commit -m "feat(hunts): sidebar Hunts section, status badges, new-hunt toasts, cooldown from reports

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: "Alle hunts" dialog with detail view

**Files:**
- Create: `src/components/hunts/AllHuntsDialog.tsx`
- Create: `src/components/hunts/HuntDetail.tsx`
- Modify: `src/components/hunts/HuntsSection.tsx` (wire `AllHuntsDialog`)

**Interfaces:**
- Consumes: `huntListItems`, `huntStatusLabel`, `formatHuntTime`, `pendingReports` (Task 4), `useHuntReports`, `useHunts`, `useAuthImage` (Task 5), `HuntStatusBadge` (Task 7), `useAuthUser<User>()` for `_id`/`admin`, shadcn `Dialog*`, `Table*`, `ToggleGroup*`, `Button`, `Badge`, `AlertDialog*` (delete confirmation).
- Produces: `<AllHuntsDialog open onOpenChange initialReportId? />`.

- [ ] **Step 1: Dialog**

- `DialogContent className="flex max-h-[92dvh] flex-col gap-3 sm:max-w-4xl max-md:h-dvh max-md:max-h-dvh max-md:max-w-none max-md:rounded-none"`; title "Alle hunts".
- Totals row: per area with at least one item a small chip `{colour dot} Alpha 2 · 10 pt` (count of app reports + website-only hunts; points from `report.site.points` / `hunt.points`), and a total `Totaal: N hunts · P pt`.
- Filter `ToggleGroup type="single"` (default `all`): Alles / Te versturen (`to_submit`+`overdue`) / Ingestuurd (`submitted`) / Beoordeeld (`judged` reports and all website-only hunts).
- Table (`overflow-y-auto` wrapper, `flex-1`): columns Foto (32 px thumbnail via a `HuntThumb` subcomponent using `useAuthImage(report.photoUrl)`; website rows show a muted "–"), Deelgebied, Code (`font-mono`), Soort, Tijd (`formatHuntTime`), Gemeld door (website rows: "jotihunt.nl"), Status (`HuntStatusBadge`; website rows: plain `Badge variant="outline"` with the raw site status), Punten. On mobile hide Foto, Soort and Gemeld door (`max-md:hidden`).
- App rows are clickable and open `HuntDetail` inside the same dialog (replace the table with the detail and a "Terug" button). `initialReportId` opens that detail directly.
- Empty state per filter: "Geen hunts in deze lijst."

- [ ] **Step 2: Detail**

- Large photo (`useAuthImage`), `max-h-[50dvh] w-full object-contain rounded-md bg-muted`, and a "Foto downloaden" button: an `<a href={objectUrl} download={`hunt-${report.huntCode}.jpg`}>` via `Button asChild`.
- Facts: deelgebied, code with copy button, tijd `HH:MM` with copy button (copies `formatHuntTime(report.huntTime)`), soort, gemeld door + `createdAt` time, deadline, ingestuurd door + tijd, site status + punten.
- Actions: when not submitted "Ingestuurd" (primary), when submitted and not judged "Terugzetten" (outline); "Verwijderen" (destructive, only when `!report.submittedAt && (user.admin || report.reportedBy === user._id)`) with an `AlertDialog` confirmation "Hunt {code} verwijderen? De foto wordt ook verwijderd." On delete success go back to the list and toast "Hunt verwijderd"; errors → `toast.error` with the server `message` when present.

- [ ] **Step 3: Wire into `HuntsSection`**

`const [allOpen, setAllOpen] = useState(false); const [selectedId, setSelectedId] = useState<string | undefined>();` — `openAll(id?)` sets both. Render `<AllHuntsDialog open={allOpen} onOpenChange={setAllOpen} initialReportId={selectedId} />`. Inside `AllHuntsDialog`, derive the shown detail id from `initialReportId` with the "adjust state during render" pattern when `open` flips to true.

- [ ] **Step 4: Verify and commit**

Run: `bun_ test`, `bun_ run build`, `bun_ run lint` → clean.

```bash
git add src/components/hunts/AllHuntsDialog.tsx src/components/hunts/HuntDetail.tsx src/components/hunts/HuntsSection.tsx
git commit -m "feat(hunts): Alle hunts dialog with filters, totals and detail view

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: End-to-end verification (containers, OCR, screenshots)

**Files:** none committed except fixes found here (commit each fix separately with a `fix(hunts): …` message).

- [ ] **Step 1: Rebuild**

`cd "/home/silke/Documents/Jotihunt 2026" && docker compose up -d --build server client`

- [ ] **Step 2: OCR check with a generated sticker**

Generate a sticker-like image (white background, black bold text "JOTIHUNT 2026" on one line and a code such as `K7X9QP2` large on the next, slight rotation of ~3°) using headless Chromium in the server image (render HTML, screenshot to `/tmp/shot2/sticker.png`). In a headless browser page of the running client (logged in as `solver@local.test` / `Solver123456`), set the file on the hidden hunt photo input (`input[type=file][accept="image/*"]`) and wait until the code field is filled. Expected: the code field contains `K7X9QP2`. Report the measured OCR result honestly if it differs, and whether adding `' '` to the whitelist changes it.

- [ ] **Step 3: Flow check**

In the same headless session: choose area Alpha, click "Nu", save. Expected: success toast; the Hunts section shows the row with "Te versturen · 29:5x"; the fox pill for Alpha shows a cooldown; a `hunt` marker for Alpha exists (`GET /markers`). Click "Ingestuurd" → badge "Ingestuurd" and an undo toast. Open "Alle hunts", open the detail, check the photo loads.

- [ ] **Step 4: Screenshots (look at every one)**

Desktop 1440×900 and mobile 390×844 (mobile UA + touch), light and dark where relevant, to `/tmp/shot2/`:
`hunts-section.png`, `hunt-register.png` (dialog with OCR result), `hunts-all.png`, `hunts-detail.png`, `hunts-mobile-button.png` (camera button above the sheet peek), `hunts-mobile-all.png`.
Chromium flags: `--no-sandbox --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`; run with
`docker run --rm --network host -v /tmp/shot2:/out -w /usr/src/app --entrypoint bun jotihunt-server /out/<script>.ts`.

- [ ] **Step 5: Clean up test data**

Delete the smoke-test reports via `DELETE /hunt-reports/:id` (after `PUT … {submitted:false}` where needed) so only real data remains; confirm `GET /hunt-reports` returns `[]`.

- [ ] **Step 6: Final checks**

Server: `bun_ test`, `bun_ run typecheck`, `bun_ run lint`. Client: `bun_ test`, `bun_ run build`, `bun_ run lint`. All clean.
