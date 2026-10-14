import type { Request, Response } from "express";
import { User } from "../models/user.model";
import { approxLocation, behindCloudflare } from "./location";
import { publicUser } from "./public-user";
import { approveQrLogin, createQrLogin, denyQrLogin, findScannedQrLogin, pollQrLogin, scanQrLogin } from "./qr-login";
import { PASSKEY_FAILED } from "./session-response";
import { createSession } from "./sessions";
import { deviceLabel } from "./user-agent";
import { updateAccounts } from "./user-store";
import { authenticationOptions, verifyAuthentication, type StoredPasskey } from "./webauthn";

const QR_GONE = { message: "Deze code werkt niet meer. Vernieuw de code op het andere apparaat.", code: "QR_GONE" };
const QR_TAKEN = { message: "Iemand anders heeft deze code al gescand.", code: "QR_TAKEN" };
const NO_PASSKEY = { message: "Voeg eerst een passkey toe aan je account.", code: "NO_PASSKEY" };

type UserPasskey = NonNullable<Request["user"]>["passkeys"][number];
const stored = (passkey: UserPasskey): StoredPasskey => ({
  credentialId: passkey.credentialId,
  publicKey: Buffer.from(passkey.publicKey),
  counter: passkey.counter,
  transports: [...passkey.transports],
});

/** Laptop: a new code to show as QR. */
export async function start(req: Request, res: Response) {
  const qr = await createQrLogin({ label: deviceLabel(req.get("user-agent")), location: approxLocation((name) => req.get(name), behindCloudflare()) });
  return res.status(201).json(qr);
}

/** Laptop: what happened to the code; after approval the session, exactly once. */
export async function poll(req: Request, res: Response) {
  const result = await pollQrLogin(String(req.params.id), req.get("x-qr-secret") ?? "");
  if (!result) return res.status(404).json(QR_GONE);
  if (result.status !== "approved") return res.status(200).json(result);
  const user = await User.findById(result.userId);
  if (!user) return res.status(404).json(QR_GONE);
  const { token } = await createSession(user._id, { label: result.label, via: "qr" });
  return res.status(200).json({ status: "approved", token, user: publicUser(user) });
}

/** Phone: claim the code and get the passkey options to confirm with. */
export async function scan(req: Request, res: Response) {
  const user = req.user!;
  if (user.passkeys.length === 0) return res.status(409).json(NO_PASSKEY);
  const options = await authenticationOptions(user.passkeys.map(stored));
  const result = await scanQrLogin(String(req.params.code), { _id: user._id, name: user.name }, options.challenge);
  if (!result.ok) return result.reason === "taken" ? res.status(409).json(QR_TAKEN) : res.status(404).json(QR_GONE);
  return res.status(200).json({ requester: result.requester, createdAt: result.createdAt, options });
}

/** Phone: the passkey assertion must come from one of the scanning user's own passkeys. */
export async function approve(req: Request, res: Response) {
  const user = req.user!;
  const code = String(req.params.code);
  const qr = await findScannedQrLogin(code, user._id);
  if (!qr?.challenge) return res.status(404).json(QR_GONE);
  const response = req.body.response as { id?: unknown };
  const passkey = user.passkeys.find((entry) => entry.credentialId === response.id);
  if (!passkey) return res.status(401).json(PASSKEY_FAILED);
  const verified = await verifyAuthentication(response, qr.challenge, stored(passkey));
  if (!verified) return res.status(401).json(PASSKEY_FAILED);
  if (!(await approveQrLogin(code, user._id, qr.challenge))) return res.status(404).json(QR_GONE);
  const now = new Date();
  await updateAccounts(
    { _id: user._id, "passkeys.credentialId": passkey.credentialId },
    { $set: { "passkeys.$.counter": verified.newCounter, "passkeys.$.lastUsedAt": now, lastActiveAt: now } },
  );
  return res.status(204).end();
}

export async function deny(req: Request, res: Response) {
  const denied = await denyQrLogin(String(req.params.code), req.user!._id);
  return denied ? res.status(204).end() : res.status(404).json(QR_GONE);
}
