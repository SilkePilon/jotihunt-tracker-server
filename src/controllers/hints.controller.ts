import { Request, Response } from "express";
import * as board from "../services/hint-board.service";
import { respond } from "../http/service-error";
import { parseRdAnswer } from "../services/rd-answer";

function cellKey(req: Request) {
  return { articleId: Number(req.params.articleId), area: String(req.params.area).toLowerCase() };
}

export function getBoard(_req: Request, res: Response) {
  return respond(res, 200, () => board.getBoard());
}

export function parseAnswer(req: Request, res: Response) {
  return res.status(200).json({ rd: parseRdAnswer(String(req.query.answer ?? "")) });
}

export function claim(req: Request, res: Response) {
  const { articleId, area } = cellKey(req);
  return respond(res, 200, () => board.claimCell(articleId, area, req.user!._id));
}

export function release(req: Request, res: Response) {
  const { articleId, area } = cellKey(req);
  return respond(res, 200, () => board.releaseCell(articleId, area, { _id: req.user!._id, admin: req.user!.admin }));
}

export function solve(req: Request, res: Response) {
  const { articleId, area } = cellKey(req);
  const { answer, replaceMarker } = req.body;
  return respond(res, 200, () => board.solveCell(articleId, area, req.user!._id, answer, replaceMarker === true));
}

export function check(req: Request, res: Response) {
  const { articleId, area } = cellKey(req);
  return respond(res, 200, () => board.setCheck(articleId, area, req.user!._id, req.body.check));
}

export function addNote(req: Request, res: Response) {
  const { articleId, area } = cellKey(req);
  return respond(res, 200, () => board.addNote(articleId, area, req.user!._id, req.body.text));
}

export function setStatus(req: Request, res: Response) {
  const { articleId, area } = cellKey(req);
  return respond(res, 200, () => board.setStatus(articleId, area, req.body.status, { _id: req.user!._id, admin: req.user!.admin }));
}
