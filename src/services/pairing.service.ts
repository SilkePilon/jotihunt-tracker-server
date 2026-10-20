import { createHash, randomInt, randomUUID } from "node:crypto";
import type { Types } from "mongoose";
import { PairingCode } from "../models/pairing-code.model";
import { User, type UserType } from "../models/user.model";
import { ServiceError } from "../http/service-error";
import { updateAccounts } from "../auth/user-store";

/** No 0/O, 1/I: codes are also typed by hand. */
export const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
export const MAX_DEVICES = 10;

const INVALID_CODE = "Deze code is ongeldig of verlopen. Maak op de site een nieuwe code.";

/** A random code of PAIRING_CODE_LENGTH characters from PAIRING_ALPHABET (`random` is injectable for tests). */
export function generatePairingCode(random: (max: number) => number = randomInt): string {
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += PAIRING_ALPHABET[random(PAIRING_ALPHABET.length)];
  return code;
}

/** Uppercase and drop separators, so "abcd-2345" and "ABCD 2345" match "ABCD2345". */
export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Hex SHA-256 of a (normalized) code; only this is stored. */
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

/**
 * Register a paired phone. One atomic update: the array is sorted by lastSeenAt and cut to MAX_DEVICES, so the least
 * recently seen devices are dropped and concurrent pairings can't lose each other's device. The new device has
 * lastSeenAt = now, so it is kept unless an existing device was seen in the future.
 */
export async function addDevice(user: UserType, name: string, now = new Date()) {
  const device = { id: randomUUID(), name: name.trim().slice(0, 60) || "Android", createdAt: now, lastSeenAt: now };
  // Also in the live edition's database while an archive is shown, so the phone stays paired there
  await updateAccounts({ _id: user._id }, { $push: { devices: { $each: [device], $sort: { lastSeenAt: 1 }, $slice: -MAX_DEVICES } } });
  const updated = await User.findById(user._id);
  syncDevices(user, updated ? listDevices(updated) : []);
  return { id: device.id, name: device.name };
}

/** Forget a paired phone, which revokes its device token. False if the user had no device with this id. */
export async function removeDevice(user: UserType, deviceId: string): Promise<boolean> {
  // Also in the live edition's database while an archive is shown, so the revoked token stays revoked
  const removed = await updateAccounts({ _id: user._id, "devices.id": deviceId }, { $pull: { devices: { id: deviceId } } });
  syncDevices(
    user,
    listDevices(user).filter((d) => d.id !== deviceId),
  );
  return removed;
}

/** The user's paired phones, least recently seen first. */
export function listDevices(user: UserType) {
  return (user.devices ?? []).map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt ?? null }));
}

/** Mirror the stored array on the loaded document without marking it modified: a later save() must not write it back. */
function syncDevices(user: UserType, devices: ReturnType<typeof listDevices>) {
  user.set("devices", devices);
  user.unmarkModified("devices");
}
