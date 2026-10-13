import type { Request, Response } from "express";
import { User } from "../models/user.model";
import { isDuplicateKeyError } from "../utils/mongo";
import { saveChallenge, takeChallenge } from "./challenges";
import { sha256 } from "./hash";
import { findRecoveryLink, useRecoveryLink } from "./recovery";
import { CHALLENGE_EXPIRED, PASSKEY_FAILED, startSession } from "./session-response";
import { deviceLabel } from "./user-agent";
import { updateAccounts } from "./user-store";
import { registrationOptions, verifyRegistration } from "./webauthn";

const LINK_GONE = { message: "Deze herstel-link werkt niet meer." };

const storedPasskeys = (user: { passkeys: { credentialId: string; publicKey: Buffer; counter: number; transports: string[] }[] }) =>
  user.passkeys.map((passkey) => ({ credentialId: passkey.credentialId, publicKey: Buffer.from(passkey.publicKey), counter: passkey.counter, transports: [...passkey.transports] }));

export async function getRecovery(req: Request, res: Response) {
  const link = await findRecoveryLink(String(req.params.token));
  const user = link ? await User.findById(link.user, { name: 1 }).lean() : null;
  if (!user) return res.status(404).json({ valid: false });
  return res.status(200).json({ valid: true, name: user.name });
}

export async function recoveryOptions(req: Request, res: Response) {
  const token = String(req.params.token);
  const link = await findRecoveryLink(token);
  const user = link ? await User.findById(link.user) : null;
  if (!user) return res.status(410).json(LINK_GONE);
  const options = await registrationOptions({ webauthnUserId: user.webauthnUserId, name: user.name }, storedPasskeys(user));
  const challengeId = await saveChallenge("register", options.challenge, { source: "herstel", tokenHash: sha256(token) });
  return res.status(200).json({ challengeId, options });
}

export async function recoveryVerify(req: Request, res: Response) {
  const token = String(req.params.token);
  const stored = await takeChallenge(String(req.body.challengeId), "register");
  if (!stored || stored.payload.source !== "herstel" || stored.payload.tokenHash !== sha256(token)) return res.status(400).json(CHALLENGE_EXPIRED);
  const verified = await verifyRegistration(req.body.response, stored.challenge);
  if (!verified) return res.status(400).json(PASSKEY_FAILED);
  const link = await useRecoveryLink(token);
  if (!link) return res.status(410).json(LINK_GONE);
  const now = new Date();
  try {
    await updateAccounts(
      { _id: link.user },
      { $push: { passkeys: { ...verified, name: deviceLabel(req.get("user-agent")), createdAt: now, lastUsedAt: now } }, $set: { lastActiveAt: now } },
    );
  } catch (error) {
    if (isDuplicateKeyError(error)) return res.status(400).json(PASSKEY_FAILED);
    throw error;
  }
  const user = await User.findById(link.user);
  if (!user) return res.status(410).json(LINK_GONE);
  return res.status(200).json(await startSession(user, req, "herstel"));
}

export async function recoveryWithoutPasskey(req: Request, res: Response) {
  const link = await useRecoveryLink(String(req.params.token));
  const user = link ? await User.findById(link.user) : null;
  if (!user) return res.status(410).json(LINK_GONE);
  return res.status(200).json(await startSession(user, req, "herstel"));
}
