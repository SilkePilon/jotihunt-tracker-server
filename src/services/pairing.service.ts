import { createHash, randomInt, randomUUID } from "node:crypto";
import type { Types } from "mongoose";
import { PairingCode } from "../models/pairing-code.model";
import { User, type UserType } from "../models/user.model";
import { ServiceError } from "../http/service-error";

/** No 0/O, 1/I: codes are also typed by hand. */
export const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
export const MAX_DEVICES = 10;

const INVALID_CODE = "Deze code is ongeldig of verlopen. Maak op de site een nieuwe code.";

export function generatePairingCode(random: (max: number) => number = randomInt): string {
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += PAIRING_ALPHABET[random(PAIRING_ALPHABET.length)];
  return code;
}

/** Uppercase and drop separators, so "abcd-2345" and "ABCD 2345" match "ABCD2345". */
export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function hashPairingCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** A new one-time code for this user (valid 5 minutes). Earlier unused codes stay valid until they expire. */
export async function createPairingCode(userId: Types.ObjectId | string, now = new Date()) {
  const code = generatePairingCode();
  const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS);
  await PairingCode.create({ codeHash: hashPairingCode(code), user: userId, expiresAt });
  return { code, expiresAt };
}

/** Mark the code used and return its user. Unknown, used or expired codes: 400. */
export async function redeemPairingCode(input: string, now = new Date()): Promise<UserType> {
  const code = normalizePairingCode(input);
  if (code.length !== PAIRING_CODE_LENGTH) throw new ServiceError(400, INVALID_CODE);
  // Atomic: two phones scanning the same code can't both get a token
  const pairing = await PairingCode.findOneAndUpdate({ codeHash: hashPairingCode(code), usedAt: null, expiresAt: { $gt: now } }, { $set: { usedAt: now } });
  if (!pairing) throw new ServiceError(400, INVALID_CODE);
  const user = await User.findById(pairing.user);
  if (!user) throw new ServiceError(400, INVALID_CODE);
  return user;
}

/** Register a paired phone; drops the least recently seen device beyond MAX_DEVICES. */
export async function addDevice(user: UserType, name: string, now = new Date()) {
  const device = { id: randomUUID(), name: name.trim().slice(0, 60) || "Android", createdAt: now, lastSeenAt: now };
  const devices = [...listDevices(user), device];
  devices.sort((a, b) => (a.lastSeenAt?.getTime() ?? a.createdAt.getTime()) - (b.lastSeenAt?.getTime() ?? b.createdAt.getTime()));
  const kept = devices.slice(Math.max(0, devices.length - MAX_DEVICES));
  user.set("devices", kept);
  await user.save();
  return { id: device.id, name: device.name };
}

export async function removeDevice(user: UserType, deviceId: string): Promise<boolean> {
  const before = user.devices?.length ?? 0;
  user.set(
    "devices",
    (user.devices ?? []).filter((d) => d.id !== deviceId),
  );
  if ((user.devices?.length ?? 0) === before) return false;
  await user.save();
  return true;
}

export function listDevices(user: UserType) {
  return (user.devices ?? []).map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt ?? null }));
}
