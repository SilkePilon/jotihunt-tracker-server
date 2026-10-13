import type { Request, Response } from "express";
import { User } from "../models/user.model";
import { isObjectIdString } from "../utils/mongo";
import { invitesPaused, setInvitesPaused } from "./invite-setting";
import { createInvite, inviteState, inviteUrl, listInvites, revokeInvite, type InviteExpiry } from "./invites";
import type { InviteDoc } from "./models";
import { createRecoveryLink } from "./recovery";

async function adminInvites(list: InviteDoc[], now = new Date()) {
  const creators = await User.find({ _id: { $in: list.map((invite) => invite.createdBy) } }, { name: 1 }).lean();
  const names = new Map(creators.map((creator) => [String(creator._id), creator.name]));
  return list.map((invite) => ({
    _id: String(invite._id),
    code: invite.code,
    url: inviteUrl(invite.code),
    createdBy: names.has(String(invite.createdBy)) ? { _id: String(invite.createdBy), name: names.get(String(invite.createdBy))! } : null,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    maxUses: invite.maxUses,
    uses: invite.uses,
    revokedAt: invite.revokedAt,
    state: inviteState(invite, now),
  }));
}

export async function getInvites(_req: Request, res: Response) {
  return res.status(200).json(await adminInvites(await listInvites()));
}

export async function postInvite(req: Request, res: Response) {
  const invite = await createInvite({ createdBy: req.user!._id, expiry: req.body.expiry as InviteExpiry, maxUses: req.body.maxUses ?? null });
  return res.status(201).json((await adminInvites([invite]))[0]);
}

export async function deleteInvite(req: Request, res: Response) {
  const id = String(req.params.id);
  const invite = isObjectIdString(id) ? await revokeInvite(id) : null;
  if (!invite) return res.status(404).json({ message: "Deze invite bestaat niet of is al ingetrokken." });
  return res.status(200).json((await adminInvites([invite]))[0]);
}

export async function getInvitesPaused(_req: Request, res: Response) {
  return res.status(200).json({ paused: await invitesPaused() });
}

export async function putInvitesPaused(req: Request, res: Response) {
  return res.status(200).json({ paused: await setInvitesPaused(req.body.paused, String(req.user!._id)) });
}

export async function postRecoveryLink(req: Request, res: Response) {
  const id = String(req.params.id);
  if (!isObjectIdString(id) || !(await User.exists({ _id: id }))) return res.status(404).json({ message: "Er is geen gebruiker met dit ID." });
  const { url, expiresAt } = await createRecoveryLink(id, req.user!._id);
  return res.status(201).json({ url, expiresAt });
}
