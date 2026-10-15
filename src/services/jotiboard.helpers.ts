import { decodeSessionKey } from "./telegram.helpers";

/**
 * Jotiboard (jotiboard.nl, our own app) keeps its data in Firebase: Auth (email/password) and the Realtime Database.
 * Values from the SPA bundle (search `databaseURL` / `jotiboard.local` in https://jotiboard.nl/assets/index-*.js if they
 * change). The API key is public (shipped to every browser), not a secret.
 */
export const JOTIBOARD_API_KEY = "AIzaSyAzRjEfPUeMEaatY7wF9CAE3wH1MWPlgx8";
export const JOTIBOARD_DB_URL = "https://jotiboard-c010d-default-rtdb.europe-west1.firebasedatabase.app";

/** The Jotiboard login form turns the username into this e-mail address. */
export function jotiboardEmail(username: string): string {
  return `${username.trim().toLowerCase()}@jotiboard.local`;
}

export interface JotiboardConfig {
  /** Base64 AES-256 key for the stored refresh token */
  sessionKey: string;
}

export function jotiboardConfigFromEnv(env: Record<string, string | undefined>, warn: (message: string) => void): JotiboardConfig | null {
  const sessionKey = env.JOTIBOARD_SESSION_KEY?.trim();
  if (!sessionKey) return null;
  try {
    decodeSessionKey(sessionKey);
  } catch {
    warn("JOTIBOARD_SESSION_KEY is not 32 bytes (base64), the Jotiboard sync is off. Generate one with: openssl rand -base64 32");
    return null;
  }
  return { sessionKey };
}
