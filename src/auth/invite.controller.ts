import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { User, type UserType } from "../models/user.model";
import { isDuplicateKeyError } from "../utils/mongo";
import { saveChallenge, takeChallenge } from "./challenges";
import { groupInfo } from "./group-info";
import { invitesPaused } from "./invite-setting";
import { claimInviteUse, findInvite, inviteState, normalizeInviteCode, releaseInviteUse, type InviteBlock } from "./invites";
import { CHALLENGE_EXPIRED, PASSKEY_FAILED, startSession } from "./session-response";
import { deviceLabel } from "./user-agent";
import { createAccount, type PasskeyFields } from "./user-store";
import { registrationOptions, verifyRegistration } from "./webauthn";

const INVITE_GONE = "Deze uitnodiging werkt niet meer.";

async function blockReason(code: string): Promise<InviteBlock | null> {
  const invite = await findInvite(code);
  if (!invite) return "unknown";
  const state = inviteState(invite);
  if (state !== "active") return state;
  return (await invitesPaused()) ? "paused" : null;
}

const gone = (res: Response, reason: InviteBlock) => res.status(410).json({ message: INVITE_GONE, reason });

export async function getInvite(req: Request, res: Response) {
  const invite = await findInvite(String(req.params.code));
  if (!invite) return res.status(404).json({ valid: false, reason: "unknown" });
  const reason = await blockReason(invite.code);
  const [group, inviter, memberCount] = await Promise.all([groupInfo(), User.findById(invite.createdBy, { name: 1 }).lean(), User.countDocuments()]);
  return res.status(200).json({ valid: reason === null, reason, group, invitedBy: inviter?.name ?? null, memberCount, onlineCount: 0 /* presence is gone; the field stays for the invite page */ });
}

export async function registerOptions(req: Request, res: Response) {
  const code = normalizeInviteCode(String(req.params.code));
  const reason = await blockReason(code);
  if (reason) return gone(res, reason);
  const name = String(req.body.name);
  const webauthnUserId = randomBytes(32).toString("base64url");
  const options = await registrationOptions({ webauthnUserId, name }, []);
  const challengeId = await saveChallenge("register", options.challenge, { source: "invite", code, name, webauthnUserId });
  return res.status(200).json({ challengeId, options });
}

/** Claim one use and create the account; the use is given back when creating fails. */
async function accountFromInvite(code: string, fields: { name: string; webauthnUserId?: string; passkey?: PasskeyFields }): Promise<UserType | InviteBlock> {
  if (await invitesPaused()) return "paused";
  const invite = await claimInviteUse(code);
  if (!invite) {
    const existing = await findInvite(code);
    if (!existing) return "unknown";
    const state = inviteState(existing);
    return state === "active" ? "full" : state;
  }
  try {
    return await createAccount({ ...fields, invite: invite._id });
  } catch (error) {
    await releaseInviteUse(invite._id);
    throw error;
  }
}

export async function registerVerify(req: Request, res: Response) {
  const code = normalizeInviteCode(String(req.params.code));
  const stored = await takeChallenge(String(req.body.challengeId), "register");
  if (!stored || stored.payload.source !== "invite" || stored.payload.code !== code) return res.status(400).json(CHALLENGE_EXPIRED);
  const verified = await verifyRegistration(req.body.response, stored.challenge);
  if (!verified) return res.status(400).json(PASSKEY_FAILED);
  let user;
  try {
    user = await accountFromInvite(code, {
      name: String(stored.payload.name),
      webauthnUserId: String(stored.payload.webauthnUserId),
      passkey: { ...verified, name: deviceLabel(req.get("user-agent")) },
    });
  } catch (error) {
    // The same passkey registered twice (double tap): the first account got it
    if (isDuplicateKeyError(error)) return res.status(400).json(PASSKEY_FAILED);
    throw error;
  }
  if (typeof user === "string") return gone(res, user);
  return res.status(201).json(await startSession(user, req, "invite"));
}

export async function registerWithoutPasskey(req: Request, res: Response) {
  const user = await accountFromInvite(normalizeInviteCode(String(req.params.code)), { name: String(req.body.name) });
  if (typeof user === "string") return gone(res, user);
  return res.status(201).json(await startSession(user, req, "invite"));
}
