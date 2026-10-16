import { generateText } from "ai";
import type { Request, Response } from "express";
import { respond } from "../http/service-error";
import { logger } from "../logger";
import { toGeminiError } from "../services/ai/gemini-error";
import { listGeminiModels } from "../services/ai/model-list";
import { requireAiModel } from "../services/ai/model";
import { adminConfig, setAiModels, type AiSlot } from "../settings/app-config";

/** Overridable in tests (local fake Google) */
export const modelListOptions: { fetchImpl?: typeof fetch; baseUrl?: string } = {};

export async function getModels(req: Request, res: Response) {
  return respond(res, 200, () => listGeminiModels({ ...modelListOptions, refresh: req.query.refresh === "1" }));
}

export async function putModels(req: Request, res: Response) {
  const models = req.body.models as Partial<Record<AiSlot, string | null>>;
  await setAiModels(models, req.user?.name ?? null);
  logger.info(`AI models changed by ${req.user?.name}: ${Object.entries(models).map(([slot, id]) => `${slot}=${id ?? "standaard"}`).join(", ")}`);
  return res.status(200).json(adminConfig());
}

/** One short call with the slot's model: is the key + model usable, and how fast */
export async function testModel(req: Request, res: Response) {
  const started = Date.now();
  try {
    await generateText({ model: requireAiModel(req.params.slot as AiSlot), prompt: "Antwoord met OK.", maxOutputTokens: 16, maxRetries: 0, abortSignal: AbortSignal.timeout(30_000) });
    return res.status(200).json({ ok: true, ms: Date.now() - started });
  } catch (error) {
    // toGeminiError passes a GeminiError (such as the missing key) through unchanged
    return res.status(200).json({ ok: false, error: toGeminiError(error).message });
  }
}
