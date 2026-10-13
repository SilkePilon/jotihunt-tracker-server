import jwt from "jsonwebtoken";

export const DEVICE_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Token of a paired phone: valid 30 days, refreshable, revoked by removing the device from the user. */
export function signDeviceToken(user: { _id: unknown }, deviceId: string) {
  return jwt.sign({ _id: String(user._id), did: deviceId, kind: "device" }, process.env.JWT_SECRET!, { expiresIn: DEVICE_TOKEN_TTL_SECONDS });
}
