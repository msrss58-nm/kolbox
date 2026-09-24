import { MULTI_ENTITY_OWNER_PASSWORD_MIN_LENGTH } from "./multi-entity-owner.constants";

/**
 * The Multi-Entity Owner's first password, as a pure function.
 *
 * DELIBERATELY ONLY WHAT THE PROVIDER ACTUALLY REQUIRES. This screen used to
 * borrow the Platform Owner's rules - twelve characters plus upper, lower,
 * digit and symbol - which were invented here, not by the auth provider. The
 * project's own auth configuration asks for a minimum length and nothing else
 * (`minimum_password_length = 6`, `password_requirements = ""`), so those
 * extra classes only ever turned a valid password into a rejected one.
 *
 * What stays: a length floor that matches the provider's, a confirmation
 * check, and a specific Hebrew message for each - so a refusal still says
 * which rule it was, rather than failing generically at the server. The
 * provider remains the authority; this is a quality gate ahead of a round
 * trip, not a boundary.
 *
 * NOT applied to any other realm. The Platform Owner keeps its own stronger
 * policy in `platformOwnerPasswordPolicy.ts`, untouched.
 */
export type MultiEntityPasswordViolation = "tooShort" | "mismatch";

/** The FIRST rule the input violates, or null when it is acceptable and both
 * fields match. The password's own length is judged before the confirmation,
 * so nobody is told "they match" about a password that would be refused. */
export function validateMultiEntityOwnerPassword(
  password: string,
  confirmation: string,
): MultiEntityPasswordViolation | null {
  if (password.length < MULTI_ENTITY_OWNER_PASSWORD_MIN_LENGTH) return "tooShort";
  if (password !== confirmation) return "mismatch";
  return null;
}
