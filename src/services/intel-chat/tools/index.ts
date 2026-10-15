import { appDataTools } from "./app-data";
import { createTurnBudget, type IntelToolContext } from "./context";
import { mapTools } from "./map";
import { ovTools } from "./ov";
import { placesTools } from "./places";
import { proposalTools } from "./proposals";
import { puzzleTools } from "./puzzle";
import { WEB_TOOL_NAMES, webTools } from "./web";

export type { IntelToolContext } from "./context";

/** Every tool of the Intel chat for one turn (with a fresh sub-call budget); names are binding for the client (UI part type `tool-<name>`) */
export function createIntelTools(turn: IntelToolContext) {
  const ctx: IntelToolContext = { ...turn, budget: createTurnBudget() };
  return { ...appDataTools(ctx), ...mapTools(ctx), ...proposalTools(ctx), ...webTools(ctx), ...puzzleTools(ctx), ...placesTools(ctx), ...ovTools(ctx) };
}

export type IntelTools = ReturnType<typeof createIntelTools>;

/** The tools the model may call this turn: the web tools only with "Web" on */
export function activeToolNames(tools: IntelTools, web: boolean): (keyof IntelTools)[] {
  return (Object.keys(tools) as (keyof IntelTools)[]).filter((name) => web || !(WEB_TOOL_NAMES as readonly string[]).includes(name));
}
