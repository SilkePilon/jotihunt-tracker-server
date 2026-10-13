import type { Request } from "express";
import type { SessionVia } from "./models";
import { createSession } from "./sessions";
import { deviceLabel } from "./user-agent";
import { publicUser } from "./public-user";

/** Log this browser in as `user`: the body every login/signup endpoint answers with. */
export async function startSession(user: Parameters<typeof publicUser>[0], req: Request, via: SessionVia) {
  const { token } = await createSession(user._id, { label: deviceLabel(req.get("user-agent")), via });
  return { token, user: publicUser(user) };
}

export const CHALLENGE_EXPIRED = { message: "Dat duurde te lang, probeer het opnieuw.", code: "CHALLENGE_EXPIRED" };
export const PASSKEY_FAILED = { message: "Dat lukte niet met deze passkey.", code: "PASSKEY_FAILED" };
export const UNKNOWN_PASSKEY = { message: "Deze passkey werkt niet meer.", code: "UNKNOWN_PASSKEY" };
