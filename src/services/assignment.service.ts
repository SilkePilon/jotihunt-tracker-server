import mongoose from "mongoose";
import { ServiceError } from "../http/service-error";
import { Article } from "../models/article.model";
import { Assignment, AssignmentStatus } from "../models/assignment.model";
import { User } from "../models/user.model";
import { isDuplicateKeyError } from "../utils/mongo";
import { conflictError, setByOther } from "./write-conflict";

type Id = mongoose.Types.ObjectId | string;

/** Attempts of a compare-and-set before giving up with a 409 (only under heavy contention on one assignment) */
const MAX_ATTEMPTS = 5;

const populateUsers = [
  { path: "owner", select: "name" },
  { path: "ownerBy", select: "name" },
  { path: "statusBy", select: "name" },
  { path: "notes.user", select: "name" },
];

const busyError = () => new ServiceError(409, "Deze opdracht werd tegelijk door iemand anders aangepast; probeer het opnieuw");
const same = (a: Id | null | undefined, b: Id | null | undefined) => String(a ?? "") === String(b ?? "");

/** Make sure the bookkeeping document of an assignment article exists (404 when the article is no assignment) */
async function ensureAssignment(articleId: number) {
  if (!(await Article.exists({ id: articleId, type: "assignment" }))) throw new ServiceError(404, "Opdracht niet gevonden");
  try {
    await Assignment.updateOne({ articleId }, { $setOnInsert: { articleId } }, { upsert: true });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error; // a concurrent first write created it
  }
}

async function view(articleId: number) {
  const assignment = await Assignment.findOne({ articleId }).populate(populateUsers);
  if (!assignment) throw new ServiceError(404, "Opdracht niet gevonden");
  return assignment;
}

export type AssignmentView = Awaited<ReturnType<typeof view>>;

/** Every assignment that has bookkeeping; articles without a document are open and unowned */
export function listAssignments() {
  return Assignment.find().populate(populateUsers).exec();
}

/** Set how far an assignment is. A status someone else set (other than open) is a 409 with `conflict`, unless `overwrite`. */
export async function setAssignmentStatus(articleId: number, status: AssignmentStatus, userId: Id, overwrite = false) {
  await ensureAssignment(articleId);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const current = await Assignment.findOne({ articleId }).lean();
    if (!current) continue;
    if (current.status === status) return view(articleId);
    if (!overwrite && current.status !== AssignmentStatus.Open && setByOther(current.statusBy, userId)) {
      throw await conflictError("De status is al gezet door iemand anders", "status", current.status, current.statusBy, current.statusAt);
    }
    const updated = await Assignment.updateOne(
      { _id: current._id, status: current.status, statusBy: current.statusBy ?? null },
      { $set: { status, statusBy: userId, statusAt: new Date() } },
    );
    if (updated.matchedCount > 0) return view(articleId);
  }
  throw busyError();
}

/**
 * Give an assignment to a user (or to nobody with null). Taking it from someone else is a 409 with `conflict`,
 * unless `overwrite`; the owner and whoever assigned them may always change it.
 */
export async function setAssignmentOwner(articleId: number, ownerId: string | null, userId: Id, overwrite = false) {
  if (ownerId !== null && !(mongoose.isValidObjectId(ownerId) && (await User.exists({ _id: ownerId })))) {
    throw new ServiceError(400, "Onbekende gebruiker");
  }
  await ensureAssignment(articleId);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const current = await Assignment.findOne({ articleId }).lean();
    if (!current) continue;
    if (same(current.owner, ownerId)) return view(articleId);
    if (!overwrite && current.owner && !same(current.owner, userId) && setByOther(current.ownerBy, userId)) {
      const owner = await User.findById(current.owner, { name: 1 }).lean();
      throw await conflictError("Deze opdracht is al van iemand anders", "owner", owner?.name, current.ownerBy, current.ownerAt);
    }
    const change = ownerId === null ? { $unset: { owner: 1 }, $set: { ownerBy: userId, ownerAt: new Date() } } : { $set: { owner: ownerId, ownerBy: userId, ownerAt: new Date() } };
    const updated = await Assignment.updateOne({ _id: current._id, owner: current.owner ?? null, ownerBy: current.ownerBy ?? null }, change);
    if (updated.matchedCount > 0) return view(articleId);
  }
  throw busyError();
}

export async function addAssignmentNote(articleId: number, userId: Id, text: string) {
  await ensureAssignment(articleId);
  await Assignment.updateOne({ articleId }, { $push: { notes: { user: userId, text, createdAt: new Date() } } });
  return view(articleId);
}

/** Everyone who can be given an assignment: id and name only */
export function listMembers() {
  return User.find({}, { name: 1 }).sort({ name: 1 }).lean();
}
