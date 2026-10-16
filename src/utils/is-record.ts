/** A plain object (not null, not an array): for checking parsed JSON */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
