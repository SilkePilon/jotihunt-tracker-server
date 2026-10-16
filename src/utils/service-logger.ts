/** What the long-running services (demo switch, Telegram, Life360, Jotiboard, 3D buildings, happy hour) log through. */
export interface ServiceLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}
