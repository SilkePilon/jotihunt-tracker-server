import { Request, Response } from "express";
import { respond } from "../http/service-error";
import * as assignments from "../services/assignment.service";

const articleId = (req: Request) => Number(req.params.articleId);

export function list(_req: Request, res: Response) {
  return respond(res, 200, () => assignments.listAssignments());
}

export function members(_req: Request, res: Response) {
  return respond(res, 200, () => assignments.listMembers());
}

export function setStatus(req: Request, res: Response) {
  return respond(res, 200, () => assignments.setAssignmentStatus(articleId(req), req.body?.status, req.user!._id));
}

export function setOwner(req: Request, res: Response) {
  return respond(res, 200, () => assignments.setAssignmentOwner(articleId(req), req.body?.owner ?? null, req.user!._id));
}

export function addNote(req: Request, res: Response) {
  return respond(res, 200, () => assignments.addAssignmentNote(articleId(req), req.user!._id, req.body?.text));
}
