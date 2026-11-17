import mongoose from "mongoose";
import { ServiceError } from "../http/service-error";
import { Article } from "../models/article.model";
import { Assignment, AssignmentStatus } from "../models/assignment.model";
import { User } from "../models/user.model";
import { isDuplicateKeyError } from "../utils/mongo";

type Id = mongoose.Types.ObjectId | string;

const populateUsers = [
  { path: "owner", select: "name" },
  { path: "ownerBy", select: "name" },
  { path: "statusBy", select: "name" },
  { path: "notes.user", select: "name" },
];

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

/** Schema defaults of SiteSubmission fields that older documents may lack */
const SITE_DEFAULTS = { imageUrl: null, answerText: null, rating: null, judgement: null, judged: false, points: null };

/**
 * Every assignment that has bookkeeping; articles without a document are open and unowned. Lean (polled by every
 * hunter): the schema defaults a hydrated document would add are filled in for documents from before those fields.
 */
export async function listAssignments() {
  const docs = await Assignment.find().populate(populateUsers).lean();
  return docs.map((doc) => ({
    ...doc,
    status: doc.status ?? AssignmentStatus.Open,
    notes: doc.notes ?? [],
    // Site fields added after a document was stored come back missing from lean: fill the schema defaults
    site: doc.site
      ? { ...SITE_DEFAULTS, ...doc.site }
      : null,
    siteAttemptAt: doc.siteAttemptAt ?? null,
  }));
}

/** Set how far an assignment is; the last write wins */
export async function setAssignmentStatus(articleId: number, status: AssignmentStatus, userId: Id) {
  await ensureAssignment(articleId);
  await Assignment.updateOne({ articleId }, { $set: { status, statusBy: userId, statusAt: new Date() } });
  return view(articleId);
}

/** Give an assignment to a user, or to nobody with null; the last write wins */
export async function setAssignmentOwner(articleId: number, ownerId: string | null, userId: Id) {
  if (ownerId !== null && !(mongoose.isValidObjectId(ownerId) && (await User.exists({ _id: ownerId })))) {
    throw new ServiceError(400, "Onbekende gebruiker");
  }
  await ensureAssignment(articleId);
  const change = ownerId === null ? { $unset: { owner: 1 }, $set: { ownerBy: userId, ownerAt: new Date() } } : { $set: { owner: ownerId, ownerBy: userId, ownerAt: new Date() } };
  await Assignment.updateOne({ articleId }, change);
  return view(articleId);
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
