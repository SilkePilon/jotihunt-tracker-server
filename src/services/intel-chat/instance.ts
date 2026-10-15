import { createModels } from "../ai/model";
import { walkMinutes } from "../prediction/instance";
import type { IntelChatModels } from "./agent";
import type { IntelToolContext } from "./tools";

let models: IntelChatModels | null | undefined;
let toolDeps: Partial<Pick<IntelToolContext, "walkMinutes" | "fetch" | "lookup">> = { walkMinutes };

/** The chat's models (purpose chat; "Denk diep" uses the prediction model); null without GEMINI_API_KEY */
export function getIntelChatModels(): IntelChatModels | null {
  if (models === undefined) {
    const byPurpose = createModels();
    models = byPurpose ? { chat: byPurpose("chat"), deep: byPurpose("prediction"), tool: byPurpose("chat") } : null;
  }
  return models;
}

/** Tests: other models (null = AI off, undefined = from the environment again) */
export function setIntelChatModels(value: IntelChatModels | null | undefined) {
  models = value;
}

/** Extra tool dependencies of the running server */
export function getIntelToolDeps() {
  return toolDeps;
}

/** Tests: fake fetch / DNS / walking */
export function setIntelToolDeps(value: Partial<Pick<IntelToolContext, "walkMinutes" | "fetch" | "lookup">>) {
  toolDeps = value;
}
