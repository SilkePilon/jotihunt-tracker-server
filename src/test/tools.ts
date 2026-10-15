import type { Tool } from "ai";

/** Run an AI SDK tool's execute the way streamText would (tests only) */
export async function runTool(tool: Tool, input: unknown): Promise<unknown> {
  if (!tool.execute) throw new Error("Tool has no execute");
  return await (tool.execute(input as never, { toolCallId: "test-call", messages: [], context: {} as never }) as Promise<unknown>);
}
