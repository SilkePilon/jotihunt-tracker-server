import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { webauthnConfig } from "./config";

export interface StoredPasskey {
  credentialId: string;
  publicKey: Buffer;
  counter: number;
  transports: string[];
}
export type VerifiedPasskey = StoredPasskey;

const transports = (list: string[]) => list as AuthenticatorTransportFuture[];

/** The only module that talks to @simplewebauthn/server (tests replace it with src/test/webauthn.ts). */
export async function registrationOptions(user: { webauthnUserId: string; name: string }, exclude: StoredPasskey[]): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const { rpId, rpName } = webauthnConfig();
  return generateRegistrationOptions({
    rpName,
    rpID: rpId,
    userName: user.name,
    userDisplayName: user.name,
    userID: Buffer.from(user.webauthnUserId, "base64url"),
    attestationType: "none",
    excludeCredentials: exclude.map((passkey) => ({ id: passkey.credentialId, transports: transports(passkey.transports) })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
}

export async function verifyRegistration(response: unknown, expectedChallenge: string): Promise<VerifiedPasskey | null> {
  const { rpId, origins } = webauthnConfig();
  try {
    const result = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge,
      expectedOrigin: origins,
      expectedRPID: rpId,
      requireUserVerification: true,
    });
    if (!result.verified || !result.registrationInfo) return null;
    const { credential } = result.registrationInfo;
    return { credentialId: credential.id, publicKey: Buffer.from(credential.publicKey), counter: credential.counter, transports: credential.transports ?? [] };
  } catch {
    return null;
  }
}

export async function authenticationOptions(allow: StoredPasskey[] = []): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const { rpId } = webauthnConfig();
  return generateAuthenticationOptions({
    rpID: rpId,
    userVerification: "required",
    allowCredentials: allow.map((passkey) => ({ id: passkey.credentialId, transports: transports(passkey.transports) })),
  });
}

/** Null when the signature, challenge, origin, user verification or counter is wrong. */
export async function verifyAuthentication(response: unknown, expectedChallenge: string, passkey: StoredPasskey): Promise<{ newCounter: number } | null> {
  const { rpId, origins } = webauthnConfig();
  try {
    const result = await verifyAuthenticationResponse({
      response: response as AuthenticationResponseJSON,
      expectedChallenge,
      expectedOrigin: origins,
      expectedRPID: rpId,
      requireUserVerification: true,
      credential: { id: passkey.credentialId, publicKey: new Uint8Array(passkey.publicKey), counter: passkey.counter, transports: transports(passkey.transports) },
    });
    return result.verified ? { newCounter: result.authenticationInfo.newCounter } : null;
  } catch {
    return null;
  }
}
