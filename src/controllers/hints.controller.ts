import { Request, Response } from "express";
import * as board from "../services/hint-board.service";
import { HintBoardError } from "../services/hint-board.service";
import { parseRdAnswer } from "../services/rd-answer";

function cellKey(req: Request) {
  return { articleId: Number(req.params.articleId), area: String(req.params.area).toLowerCase() };
}

async function respond(res: Response, action: () => Promise<unknown>) {
  try {
    return res.status(200).json(await action());
  } catch (error) {
    if (error instanceof HintBoardError) {
      return res.status(error.status).json({ message: error.message, ...error.details });
    }
    throw error;
  }
}

export function getBoard(_req: Request, res: Response) {
  return respond(res, () => board.getBoard());
}

export function parseAnswer(req: Request, res: Response) {
  return res.status(200).json({ rd: parseRdAnswer(String(req.query.answer ?? "")) });
}

export function claim(req: Request, res: Response) {
  const { articleId, area } = cellKey(req);
  return respond(res, () => board.claimCell(articleId, area, req.user!._id));
}

export function release(req: Request, res: Response) {
  const { articleId, area } = cellKey(req);
  return respond(res, () => board.releaseCell(articleId, area, { _id: req.user!._id, admin: req.user!.admin }));
}

export function solve(req: Request, res: Response) {
  const { articleId, area } = cellKey(req);
  const { answer, replaceMarker } = req.body;
  return respond(res, () => board.solveCell(articleId, area, req.user!._id, answer, replaceMarker === true));
}

export function check(req: Request, res: Response) {
  const { articleId, area } = cellKey(req);
  return respond(res, () => board.setCheck(articleId, area, req.user!._id, req.body.check));
}

export function addNote(req: Request, res: Response) {
  const { articleId, area } = cellKey(req);
  return respond(res, () => board.addNote(articleId, area, req.user!._id, req.body.text));
}

export function setStatus(req: Request, res: Response) {
  const { articleId, area } = cellKey(req);
  return respond(res, () => board.setStatus(articleId, area, req.body.status));
}
