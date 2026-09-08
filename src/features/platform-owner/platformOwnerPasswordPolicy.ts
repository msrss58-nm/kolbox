import {
  PLATFORM_OWNER_PASSWORD_MAX_BYTES,
  PLATFORM_OWNER_PASSWORD_MIN_LENGTH,
} from "./platform-owner.constants";

/**
 * Platform Stage 2 (password set/recovery): the Platform Owner's password
 * rules, as a pure function so they are trivially testable and have exactly
 * one definition.
 *
 * This is a CLIENT-SIDE quality gate, not a security boundary - Supabase
 * enforces its own project-level password policy server-side and remains the
 * authority. Validating here just means an obviously weak password is
 * rejected before a network round trip, and that the user gets a specific
 * Hebrew message instead of a generic server error.
 *
 * The Platform Owner is the single most privileged identity in the system, so
 * the bar is deliberately higher than the campaign app's: length is the
 * dominant factor, with character-class requirements on top.
 */

export type PlatformPasswordViolation =
  | "tooShort"
  | "tooLong"
  | "missingLower"
  | "missingUpper"
  | "missingDigit"
  | "missingSymbol"
  | "mismatch";

/** Anything that is not a letter, a digit, or whitespace counts as a symbol -
 * deliberately broad, so a non-ASCII keyboard is not penalised. */
const SYMBOL_PATTERN = /[^\p{L}\p{N}\s]/u;

/**
 * Returns the FIRST rule the input violates, or `null` when the password is
 * acceptable and both fields match. Fail-closed ordering: the password's own
 * strength is judged before the confirmation, so a user is never told
 * "passwords match" about a password that would be rejected anyway.
 *
 * The password value itself is never returned, logged, or embedded in the
 * result - only the violation's identity.
 */
export function validatePlatformOwnerPassword(
  password: string,
  confirmation: string,
): PlatformPasswordViolation | null {
  if (password.length < PLATFORM_OWNER_PASSWORD_MIN_LENGTH) return "tooShort";
  // bcrypt truncates past 72 BYTES and GoTrue rejects longer input outright.
  if (new TextEncoder().encode(password).length > PLATFORM_OWNER_PASSWORD_MAX_BYTES) {
    return "tooLong";
  }
  // ASCII a-z / A-Z on purpose: the Hebrew rule text promises "באנגלית", and a
  // Unicode-wide letter class would accept a Cyrillic-only password while the UI
  // insists it is invalid. The rule and the copy must agree.
  if (!/[a-z]/.test(password)) return "missingLower";
  if (!/[A-Z]/.test(password)) return "missingUpper";
  if (!/\p{N}/u.test(password)) return "missingDigit";
  if (!SYMBOL_PATTERN.test(password)) return "missingSymbol";
  if (password !== confirmation) return "mismatch";
  return null;
}
