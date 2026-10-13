import { inviteSettings } from "./models";

const KEY = "invites";

export async function invitesPaused(): Promise<boolean> {
  return (await inviteSettings().findOne({ key: KEY }).lean())?.paused ?? false;
}

export async function setInvitesPaused(paused: boolean, updatedBy: string | null): Promise<boolean> {
  await inviteSettings().updateOne({ key: KEY }, { $set: { paused, updatedAt: new Date(), updatedBy } }, { upsert: true });
  return paused;
}
