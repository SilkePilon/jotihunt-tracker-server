import { createSession } from "../auth/sessions";

process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret";

const tokens = new Map<string, string>();

/** Give a test user a web session; its token is then available through tokenFor(user). */
export async function withSession<T extends { _id: unknown }>(user: T): Promise<T> {
  const { token } = await createSession(user._id, { label: "Test", via: "passkey" });
  tokens.set(String(user._id), token);
  return user;
}

export function tokenFor(user: { _id: unknown }): string {
  const token = tokens.get(String(user._id));
  if (!token) throw new Error(`No session for user ${String(user._id)}: create the user with withSession()`);
  return token;
}
