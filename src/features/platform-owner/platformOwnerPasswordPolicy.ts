/**
 * The Platform Owner's first/replacement password check, as a pure function so
 * it has exactly one definition and is trivially testable.
 *
 * KOLBOX IMPOSES NO PASSWORD POLICY OF ITS OWN. There is no length floor, no
 * length ceiling and no character-class requirement here: a password may be
 * short, long, Hebrew, English, digits, symbols, spaces or any mix of them.
 * The rules that used to live here - twelve characters plus upper, lower,
 * digit and symbol, and a 72-byte ceiling - were this application's invention,
 * not the auth provider's, and they only ever turned passwords the provider
 * would have accepted into refusals.
 *
 * The auth provider remains the sole authority on what it will accept, and its
 * refusal is surfaced as-is rather than pre-empted or second-guessed.
 *
 * The password is NEVER trimmed, normalised, case-folded or altered in any
 * way, and is never returned, logged or embedded in the result - only the
 * identity of the violation is.
 */
export type PlatformPasswordViolation = "empty" | "mismatch";

/**
 * Returns the FIRST rule the input violates, or null when it is acceptable and
 * both fields match. Only two things can be wrong: nothing was typed, or the
 * confirmation does not match EXACTLY (compared character for character, with
 * no trimming on either side).
 */
export function validatePlatformOwnerPassword(
  password: string,
  confirmation: string,
): PlatformPasswordViolation | null {
  if (password === "") return "empty";
  if (password !== confirmation) return "mismatch";
  return null;
}
