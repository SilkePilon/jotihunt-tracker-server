/** The message of an Error, or the thrown value as a string (for logs and error messages). */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
