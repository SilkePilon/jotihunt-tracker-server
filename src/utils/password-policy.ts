import type { ValidationChain } from "express-validator";

/** Shortest password that can be set or changed. Not checked on login, so existing shorter passwords keep working. */
export const PASSWORD_MIN_LENGTH = 8;
/** Longest password accepted (argon2 hashes any length; this only bounds the work per request). */
export const PASSWORD_MAX_LENGTH = 200;

export const PASSWORD_TOO_SHORT = `Wachtwoord moet minstens ${PASSWORD_MIN_LENGTH} tekens zijn.`;

/** Rules for a password that is being set (new account, change or admin reset). */
export function newPasswordRules(chain: ValidationChain): ValidationChain {
  return chain
    .isString()
    .withMessage("Wachtwoord moet tekst zijn.")
    .bail()
    .isLength({ min: PASSWORD_MIN_LENGTH })
    .withMessage(PASSWORD_TOO_SHORT)
    .bail()
    .isLength({ max: PASSWORD_MAX_LENGTH })
    .withMessage(`Wachtwoord mag maximaal ${PASSWORD_MAX_LENGTH} tekens zijn.`);
}
