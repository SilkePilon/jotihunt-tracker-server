export interface PublicUser {
  _id: string;
  name: string;
  admin: boolean;
  tutorialVersion: number;
  passkeyCount: number;
}

/** The user as the web app stores it after logging in. */
export function publicUser(user: { _id: unknown; name: string; admin: boolean; tutorialVersion?: number | null; passkeys?: unknown[] | null }): PublicUser {
  return {
    _id: String(user._id),
    name: user.name,
    admin: user.admin,
    tutorialVersion: user.tutorialVersion ?? 0,
    passkeyCount: user.passkeys?.length ?? 0,
  };
}
