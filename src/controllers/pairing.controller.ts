import { Request, Response } from "express";
import { respond, ServiceError } from "../http/service-error";
import { DEVICE_TOKEN_TTL_SECONDS, signDeviceToken } from "../services/access-token";
import { addDevice, createPairingCode, listDevices, redeemPairingCode, removeDevice } from "../services/pairing.service";
import { onboarding } from "../services/tracker-onboarding.instance";

const DEVICE_ONLY = "Alleen voor gekoppelde apparaten.";

/** POST /tracker/pair: a one-time code for the QR on the site. */
export function createCode(req: Request, res: Response) {
  return respond(res, 201, () => createPairingCode(req.user!._id));
}

/** POST /auth/pair: exchange a code for a device token, plus what the app needs to start tracking. */
export function pair(req: Request, res: Response) {
  return respond(res, 200, async () => {
    const user = await redeemPairingCode(String(req.body.code));
    const device = await addDevice(user, String(req.body.deviceName ?? "Android"));
    return {
      accessToken: signDeviceToken(user, device.id),
      expiresIn: DEVICE_TOKEN_TTL_SECONDS,
      device,
      user: { _id: user._id, name: user.name, admin: user.admin },
      tracker: await onboarding.getMe(user),
    };
  });
}

/** POST /auth/refresh: a fresh 30-day token for the calling phone. */
export function refresh(req: Request, res: Response) {
  return respond(res, 200, async () => {
    const deviceId = res.locals.deviceId as string | undefined;
    if (!deviceId) throw new ServiceError(400, DEVICE_ONLY);
    return { accessToken: signDeviceToken(req.user!, deviceId), expiresIn: DEVICE_TOKEN_TTL_SECONDS };
  });
}

/** GET /auth/devices: the user's paired phones; `current` marks the phone making the request. */
export function list(req: Request, res: Response) {
  const current = res.locals.deviceId as string | undefined;
  return res.status(200).json({ devices: listDevices(req.user!).map((device) => ({ ...device, current: device.id === current })) });
}

/** DELETE /auth/devices/me: the phone unpairs itself. */
export function removeCurrent(req: Request, res: Response) {
  return respond(res, 204, async () => {
    const deviceId = res.locals.deviceId as string | undefined;
    if (!deviceId) throw new ServiceError(400, DEVICE_ONLY);
    await removeDevice(req.user!, deviceId);
  });
}

/** DELETE /auth/devices/:id: forget a paired phone (from the site); unknown id → 404. */
export function remove(req: Request, res: Response) {
  return respond(res, 204, async () => {
    if (!(await removeDevice(req.user!, String(req.params.id)))) throw new ServiceError(404, "Apparaat niet gevonden.");
  });
}
