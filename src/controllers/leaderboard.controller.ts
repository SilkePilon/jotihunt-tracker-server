import { Request, Response } from "express";
import { logger } from "..";
import * as traccarrService from "../services/traccarr.service";
import { createTraccarApi } from "../services/traccar-api";
import { describeTraccarError, traccarHttp } from "../services/traccar-http";
import { createLeaderboardService } from "../services/leaderboard.service";
import { onDemoSwitch } from "../demo/database-switch";

const leaderboard = createLeaderboardService({
  api: traccarrService.isTraccarConfigured ? createTraccarApi(traccarHttp) : null,
  huntStart: process.env.HUNT_START_TIME,
  huntEnd: process.env.HUNT_END_TIME,
  onError: (error) => logger.warn(`Leaderboard distances: ${describeTraccarError(error)}`),
});

onDemoSwitch(() => leaderboard.clearCache());

export async function getLeaderboard(_req: Request, res: Response) {
  return res.status(200).json(await leaderboard.get());
}
