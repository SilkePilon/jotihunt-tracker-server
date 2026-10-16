import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { decodeSessionKey, decryptSession, encryptSession, isValidSessionKey } from "./session-crypto";

describe("session encryption", () => {
  const key = randomBytes(32).toString("base64");
  test("round trip, fresh iv every time", () => {
    const a = encryptSession("secret-session", key);
    const b = encryptSession("secret-session", key);
    expect(a.ciphertext).not.toContain("secret");
    expect(a.iv).not.toBe(b.iv);
    expect(decryptSession(a, key)).toBe("secret-session");
  });
  test("a wrong key or a tampered ciphertext throws", () => {
    const encrypted = encryptSession("secret-session", key);
    expect(() => decryptSession(encrypted, randomBytes(32).toString("base64"))).toThrow();
    const tampered = Buffer.from(encrypted.ciphertext, "base64");
    tampered[0] ^= 1;
    expect(() => decryptSession({ ...encrypted, ciphertext: tampered.toString("base64") }, key)).toThrow();
  });
  test("the key must decode to 32 bytes", () => {
    expect(() => decodeSessionKey(randomBytes(16).toString("base64"))).toThrow();
    expect(() => decodeSessionKey("")).toThrow();
    expect(() => encryptSession("x", "kort")).toThrow();
    expect(decodeSessionKey(key)).toHaveLength(32);
    expect(isValidSessionKey(key)).toBe(true);
    expect(isValidSessionKey("kort")).toBe(false);
  });
});
