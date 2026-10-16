import { Request, Response } from "express";
import { setTutorialVersion } from "../models/user.model";

export async function updateTutorial(req: Request, res: Response) {
  const tutorialVersion = await setTutorialVersion(req.user!, req.body.version);
  return res.status(200).json({ tutorialVersion });
}
