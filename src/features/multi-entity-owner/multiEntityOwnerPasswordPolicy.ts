/**
 * The Multi-Entity Owner's first password, as a pure function.
 *
 * KOLBOX IMPOSES NO PASSWORD POLICY OF ITS OWN - no length floor, no ceiling,
 * no character classes. The previous minimum length was removed along with
 * every other application-level password rule in this project; the auth
 * provider is the only authority on what it accepts, and its refusal is
 * surfaced as-is.
 *
 * The password is never trimmed, normalised or altered, and never logged.
 */
export type MultiEntityPasswordViolation = "empty" | "mismatch";

/** The FIRST rule the input violates, or null when it is acceptable and both
 * fields match EXACTLY (character for character, nothing trimmed). */
export function validateMultiEntityOwnerPassword(
  password: string,
  confirmation: string,
): MultiEntityPasswordViolation | null {
  if (password === "") return "empty";
  if (password !== confirmation) return "mismatch";
  return null;
}
