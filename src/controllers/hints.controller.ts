import { Request, Response } from "express";
import * as board from "../services/hint-board.service";
import { respond } from "../http/service-error";
import { parseRdAnswer } from "../services/rd-answer";

function cellKey(req: Request) {
  return { articleId: Number(req.params.articleId), area: String(req.params.area).toLowerCase() };
}

/** Sent as prebuilt JSON (shared between users for ~1.5 s); same body and headers as res.json(board). */
export async function getBoard(_req: Request, res: Response) {
  const json = await board.getBoardJson();
  return res.status(200).type("json").send(json);
}

export function parseAnswer(req: Request, res: Response) {
  return res.status(200).json({ rd: parseRdAnswer(String(req.query.answer ?? "")) });
}

export function solve(req: Request, res: Response) {
  const { articleId, area } = cellKey(req);
  const { answer, replaceMarker } = req.body;
  return respond(res, 200, () => board.solveCell(articleId, area, answer, replaceMarker === true));
}
