import { general } from "../settings/app-config";

type Env = Record<string, string | undefined>;

export interface WebauthnConfig {
  rpId: string;
  rpName: string;
  /** Every origin the site is served from (e.g. https://jotihunt.example and http://localhost:5173 in dev) */
  origins: string[];
}

/** WebAuthn relying party settings. Throws when a required variable is missing (checked at startup). */
export function webauthnConfig(env: Env = process.env): WebauthnConfig {
  const rpId = env.WEBAUTHN_RP_ID?.trim();
  if (!rpId) throw new Error("WEBAUTHN_RP_ID is not set");
  const origins = (env.WEBAUTHN_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length === 0) throw new Error("WEBAUTHN_ORIGINS is not set");
  return { rpId, rpName: env.WEBAUTHN_RP_NAME?.trim() || "Jotihunt Tracker", origins };
}

/** Base URL of the web app, used in invite and herstel links. */
export function publicAppUrl(env: Env = process.env): string {
  const url = env.PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  if (!url) throw new Error("PUBLIC_APP_URL is not set");
  return url;
}

/** The own group (Beheer → Algemeen, else HOME_TEAM_API_ID / GROUP_NAME). */
export function groupConfig(): { homeTeamApiId: number | null; groupName: string | null } {
  return { homeTeamApiId: general("homeTeamApiId").value, groupName: general("groupName").value };
}
