import { mock } from "bun:test";
import type { StoredPasskey } from "../auth/webauthn";

/**
 * Fake WebAuthn for HTTP tests. A registration response `{ id }` registers credential `id` unless id is "bad"; an
 * authentication response `{ id, response: { signature: "valid" } }` passes. Challenges are fixed strings.
 */
export const fakeWebauthn = {
  registrationOptions: async (user: { webauthnUserId: string; name: string }, exclude: StoredPasskey[]) => ({
    challenge: "reg-challenge",
    rp: { id: "localhost", name: "Test" },
    user: { id: user.webauthnUserId, name: user.name, displayName: user.name },
    pubKeyCredParams: [],
    excludeCredentials: exclude.map((passkey) => ({ id: passkey.credentialId, type: "public-key" })),
  }),
  verifyRegistration: async (response: unknown, challenge: string) => {
    const id = (response as { id?: unknown })?.id;
    if (challenge !== "reg-challenge" || typeof id !== "string" || id === "bad") return null;
    return { credentialId: id, publicKey: Buffer.from(`pk-${id}`), counter: 0, transports: ["internal"] };
  },
  authenticationOptions: async (allow: StoredPasskey[] = []) => ({
    challenge: "auth-challenge",
    allowCredentials: allow.map((passkey) => ({ id: passkey.credentialId, type: "public-key" })),
  }),
  verifyAuthentication: async (response: unknown, challenge: string, passkey: StoredPasskey) => {
    const signature = (response as { response?: { signature?: unknown } })?.response?.signature;
    return challenge === "auth-challenge" && signature === "valid" ? { newCounter: passkey.counter + 1 } : null;
  },
};

/** Call before importing the app. */
export function installFakeWebauthn() {
  mock.module("../auth/webauthn", () => fakeWebauthn);
}
