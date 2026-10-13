import type { Request, Response } from "express";
import { User } from "../models/user.model";
import { saveChallenge, takeChallenge } from "./challenges";
import { revokeSession } from "./sessions";
import { publicUser } from "./public-user";
import { updateAccounts } from "./user-store";
import { authenticationOptions, verifyAuthentication } from "./webauthn";
import { CHALLENGE_EXPIRED, PASSKEY_FAILED, startSession, UNKNOWN_PASSKEY } from "./session-response";

/** Discoverable login: no user name, the browser offers the passkeys it has for this site. */
export async function loginOptions(_req: Request, res: Response) {
  const options = await authenticationOptions();
  const challengeId = await saveChallenge("login", options.challenge);
  return res.status(200).json({ challengeId, options });
}

export async function loginVerify(req: Request, res: Response) {
  const stored = await takeChallenge(String(req.body.challengeId), "login");
  if (!stored) return res.status(400).json(CHALLENGE_EXPIRED);
  const response = req.body.response as { id?: unknown } | undefined;
  const credentialId = typeof response?.id === "string" ? response.id : "";
  const user = credentialId ? await User.findOne({ "passkeys.credentialId": credentialId }) : null;
  const passkey = user?.passkeys.find((entry) => entry.credentialId === credentialId);
  if (!user || !passkey) return res.status(401).json(UNKNOWN_PASSKEY);

  const verified = await verifyAuthentication(response, stored.challenge, {
    credentialId: passkey.credentialId,
    publicKey: Buffer.from(passkey.publicKey),
    counter: passkey.counter,
    transports: [...passkey.transports],
  });
  if (!verified) return res.status(401).json(PASSKEY_FAILED);

  const now = new Date();
  await updateAccounts(
    { _id: user._id, "passkeys.credentialId": credentialId },
    { $set: { "passkeys.$.counter": verified.newCounter, "passkeys.$.lastUsedAt": now, lastActiveAt: now } },
  );
  return res.status(200).json(await startSession(user, req, "passkey"));
}

export function me(req: Request, res: Response) {
  return res.status(200).json(publicUser(req.user!));
}

/** Log this browser out (device tokens have their own unpair route). */
export async function logout(_req: Request, res: Response) {
  if (typeof res.locals.sessionId === "string") await revokeSession(res.locals.sessionId);
  return res.status(204).end();
}
