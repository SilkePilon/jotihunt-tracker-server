import type { Request, Response } from "express";
import { User } from "../models/user.model";
import { isDuplicateKeyError } from "../utils/mongo";
import { saveChallenge, takeChallenge } from "./challenges";
import { publicUser } from "./public-user";
import { CHALLENGE_EXPIRED, PASSKEY_FAILED } from "./session-response";
import { deviceLabel } from "./user-agent";
import { updateAccounts } from "./user-store";
import { registrationOptions, verifyRegistration } from "./webauthn";

export async function addPasskeyOptions(req: Request, res: Response) {
  const user = req.user!;
  const exclude = user.passkeys.map((passkey) => ({ credentialId: passkey.credentialId, publicKey: Buffer.from(passkey.publicKey), counter: passkey.counter, transports: [...passkey.transports] }));
  const options = await registrationOptions({ webauthnUserId: user.webauthnUserId, name: user.name }, exclude);
  const challengeId = await saveChallenge("add-passkey", options.challenge, { userId: String(user._id) });
  return res.status(200).json({ challengeId, options });
}

export async function addPasskeyVerify(req: Request, res: Response) {
  const user = req.user!;
  const stored = await takeChallenge(String(req.body.challengeId), "add-passkey");
  if (!stored || stored.payload.userId !== String(user._id)) return res.status(400).json(CHALLENGE_EXPIRED);
  const verified = await verifyRegistration(req.body.response, stored.challenge);
  if (!verified) return res.status(400).json(PASSKEY_FAILED);
  const now = new Date();
  try {
    await updateAccounts({ _id: user._id }, { $push: { passkeys: { ...verified, name: deviceLabel(req.get("user-agent")), createdAt: now, lastUsedAt: null } } });
  } catch (error) {
    if (isDuplicateKeyError(error)) return res.status(400).json(PASSKEY_FAILED);
    throw error;
  }
  return res.status(201).json({ user: publicUser((await User.findById(user._id))!) });
}
