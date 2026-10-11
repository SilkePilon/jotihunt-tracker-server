import jwt from "jsonwebtoken";

export const DEVICE_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** iat (whole seconds) that is never before the user's last password change, so a fresh token is never rejected. */
function issuedAt(user: { passwordChangedAt?: Date | null }) {
  const now = Math.floor(Date.now() / 1000);
  const changedAt = user.passwordChangedAt ? Math.ceil(user.passwordChangedAt.getTime() / 1000) : 0;
  return Math.max(now, changedAt);
}

/** Web session token (with enough lifetime for the whole hunt). */
export function signAccessToken(user: { _id: unknown; passwordChangedAt?: Date | null }) {
  return jwt.sign({ _id: user._id, iat: issuedAt(user) }, process.env.JWT_SECRET!, { expiresIn: "36h" });
}

/** Token of a paired phone: valid 30 days, refreshable, revoked by removing the device from the user. */
export function signDeviceToken(user: { _id: unknown; passwordChangedAt?: Date | null }, deviceId: string) {
  return jwt.sign({ _id: user._id, did: deviceId, kind: "device", iat: issuedAt(user) }, process.env.JWT_SECRET!, {
    expiresIn: DEVICE_TOKEN_TTL_SECONDS,
  });
}
