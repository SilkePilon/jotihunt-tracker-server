import { Request, Response } from "express";
import { Team } from "../models/team.model";
import { logger } from "../logger";
import { syncTeams } from "../services/team-sync.service";

export async function getTeams(_req: Request, res: Response) {
  const teams = await Team.find().lean();
  return res.status(200).json(teams);
}

export async function setTeamArea(req: Request, res: Response) {
  const { id } = req.params;
  const { area } = req.body;

  const team = await Team.findByIdAndUpdate(id, area ? { $set: { area } } : { $unset: { area: "" } }, { returnDocument: "after" });
  if (!team) return res.status(404).json({ message: "Team not found" });
  return res.status(200).json(team);
}

export async function reloadTeams(_req: Request, res: Response) {
  try {
    const count = await syncTeams();
    logger.info(`Reloaded ${count} teams from the Jotihunt API`);
    return res.status(200).json({ message: "Teams reloaded", count });
  } catch (error) {
    logger.error("Error reloading teams:", error);
    return res.status(502).json({ message: "Error reloading teams" });
  }
}
