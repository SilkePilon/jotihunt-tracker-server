import { aiAvailable, requireAiModel } from "../ai/model";
import { walkMinutes } from "../prediction/instance";
import type { IntelChatModels } from "./agent";
import type { IntelToolContext } from "./tools";

/** Tests: fixed models (null = AI off); undefined = from the app config */
let override: IntelChatModels | null | undefined;
const toolDeps: Partial<Pick<IntelToolContext, "walkMinutes" | "fetch" | "lookup">> = { walkMinutes };

/** The chat's models, read per request (Beheer → AI); null without a Gemini key */
export function getIntelChatModels(): IntelChatModels | null {
  if (override !== undefined) return override;
  if (!aiAvailable()) return null;
  return { chat: requireAiModel("chat"), deep: requireAiModel("deep"), tool: requireAiModel("tools") };
}

export function setIntelChatModels(value: IntelChatModels | null | undefined) {
  override = value;
}

/** Extra tool dependencies of the running server */
export function getIntelToolDeps() {
  return toolDeps;
}
