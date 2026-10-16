import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encryption of the stored session secrets (Telegram session, Life360 token, Jotiboard refresh token), each with its
 * own key: TELEGRAM_SESSION_KEY, LIFE360_SESSION_KEY or JOTIBOARD_SESSION_KEY (base64 of 32 bytes, AES-256-GCM).
 */
export interface EncryptedSession {
  ciphertext: string;
  iv: string;
  tag: string;
}

/** A session key: base64 of exactly 32 bytes (AES-256). Throws otherwise. */
export function decodeSessionKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64.trim(), "base64");
  if (key.length !== 32) throw new Error("The session key (TELEGRAM_SESSION_KEY, LIFE360_SESSION_KEY or JOTIBOARD_SESSION_KEY) must be 32 bytes, base64 encoded");
  return key;
}

/** True when the key decodes to 32 bytes; the *ConfigFromEnv functions turn their feature off (with a warning) otherwise. */
export function isValidSessionKey(keyB64: string): boolean {
  try {
    decodeSessionKey(keyB64);
    return true;
  } catch {
    return false;
  }
}

/** AES-256-GCM with a fresh 12-byte iv; all parts base64. */
export function encryptSession(plain: string, keyB64: string): EncryptedSession {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", decodeSessionKey(keyB64), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

/** Throws on a wrong key or tampered data (GCM authentication). */
export function decryptSession(encrypted: EncryptedSession, keyB64: string): string {
  const decipher = createDecipheriv("aes-256-gcm", decodeSessionKey(keyB64), Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, "base64")), decipher.final()]).toString("utf8");
}
