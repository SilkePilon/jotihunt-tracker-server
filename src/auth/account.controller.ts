import type { Request, Response } from "express";
import { User } from "../models/user.model";
import { listDevices } from "../services/pairing.service";
import { isDuplicateKeyError, isObjectIdString } from "../utils/mongo";
import { saveChallenge, takeChallenge } from "./challenges";
import { sessions, type SessionDoc } from "./models";
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

const PASSKEY_NOT_FOUND = { message: "Passkey niet gevonden." };
const LAST_PASSKEY = { message: "Je laatste passkey kan niet weg, anders kom je niet meer binnen.", code: "LAST_PASSKEY" };
const SESSION_NOT_FOUND = { message: "Sessie niet gevonden." };

/** Everything the Account dialog shows: passkeys (no key material), live web sessions and paired Android phones. */
export async function overview(req: Request, res: Response) {
  const user = req.user!;
  const live = await sessions()
    .find({ user: user._id, expiresAt: { $gt: new Date() } })
    .sort({ lastUsedAt: -1 })
    .lean<SessionDoc[]>();
  return res.status(200).json({
    passkeys: user.passkeys.map((passkey) => ({ id: passkey.credentialId, name: passkey.name, createdAt: passkey.createdAt, lastUsedAt: passkey.lastUsedAt ?? null })),
    sessions: live.map((session) => ({
      id: String(session._id),
      label: session.label,
      via: session.via,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      current: String(session._id) === res.locals.sessionId,
    })),
    devices: listDevices(user),
  });
}

export async function renamePasskey(req: Request, res: Response) {
  const user = req.user!;
  const id = String(req.params.id);
  if (!user.passkeys.some((passkey) => passkey.credentialId === id)) return res.status(404).json(PASSKEY_NOT_FOUND);
  await updateAccounts({ _id: user._id, "passkeys.credentialId": id }, { $set: { "passkeys.$.name": String(req.body.name) } });
  return res.status(204).end();
}

export async function removePasskey(req: Request, res: Response) {
  const user = req.user!;
  const id = String(req.params.id);
  if (!user.passkeys.some((passkey) => passkey.credentialId === id)) return res.status(404).json(PASSKEY_NOT_FOUND);
  if (user.passkeys.length <= 1) return res.status(409).json(LAST_PASSKEY);
  // Only while a second passkey exists: two tabs removing the last two at once leave one
  await updateAccounts({ _id: user._id, "passkeys.credentialId": id, "passkeys.1": { $exists: true } }, { $pull: { passkeys: { credentialId: id } } });
  const updated = await User.findById(user._id);
  if (!updated) return res.status(404).json(PASSKEY_NOT_FOUND);
  if (updated.passkeys.some((passkey) => passkey.credentialId === id)) return res.status(409).json(LAST_PASSKEY);
  return res.status(200).json({ user: publicUser(updated) });
}

/** Log out one browser of this user (also the current one). */
export async function removeSession(req: Request, res: Response) {
  const id = String(req.params.id);
  if (!isObjectIdString(id)) return res.status(404).json(SESSION_NOT_FOUND);
  const result = await sessions().deleteOne({ _id: id, user: req.user!._id });
  return result.deletedCount ? res.status(204).end() : res.status(404).json(SESSION_NOT_FOUND);
}

/** Log out every other browser of this user; this one stays logged in. */
export async function removeOtherSessions(req: Request, res: Response) {
  const result = await sessions().deleteMany({ user: req.user!._id, _id: { $ne: res.locals.sessionId } });
  return res.status(200).json({ removed: result.deletedCount });
}
