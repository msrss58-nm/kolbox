/**
 * Which realm class one submit of the KOLBOX Auth entry belongs to.
 *
 * A PURE function of the user's own input, with ZERO network calls - which is
 * exactly what stops realm resolution from being an unauthenticated
 * account-enumeration oracle. Nothing here asks the server anything, so
 * nothing here can confirm that an address exists or which realm owns it.
 *
 * WHY NOT DISCRIMINATE ON EMAIL SHAPE ALONE. A PermissionUser's name may
 * legally contain "@": `election_day_create_permission_user_owner_v3`
 * validates only `btrim(p_name) <> ''` and `election_day_permission_users`
 * carries no CHECK constraint on `name`. Email shape is a HEURISTIC, never an
 * invariant, and routing on it alone would silently send a worker's password
 * to GoTrue.
 *
 * The sound discriminator is the WORKSPACE CODE - an input that exists in
 * exactly one realm: `election_day_login_v3` requires it (server-enforced)
 * and no owner realm has any such concept.
 *
 * Note this resolves a realm CLASS only. Which of the three owner realms an
 * email belongs to is decided by the server AFTER authentication, using no
 * password - never before it.
 */
export type EntryRealm = "worker" | "owner" | "incomplete";

export interface EntryRealmInput {
  identifier: string;
  workspaceCode: string;
  /** The user explicitly asked for the staff form (system code + username). */
  staffMode: boolean;
}

/**
 * Deliberately conservative: a non-empty local part, "@", a dotted domain, no
 * whitespace. Used ONLY to choose which realm's handler a submit goes to -
 * never to validate an address, and never as a security decision.
 */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * ONE SUBMIT -> EXACTLY ONE REALM -> EXACTLY ONE CREDENTIAL-BEARING REQUEST.
 *
 * The obvious wrong implementation is "try the worker realm, and if that
 * fails try the owner realm". Never do that. A cross-realm fallback would
 * (a) burn an `election_day_register_login_attempt` bucket on every owner
 * sign-in, (b) bcrypt an owner's password against a foreign realm's hashes
 * inside the worker RPC, and (c) create a timing oracle separating "exists in
 * realm A" from "exists in neither". A failure in the chosen realm is
 * reported, never retried elsewhere.
 *
 * Ordered rules - the order is the design:
 *   1. no identifier yet            -> incomplete
 *   2. a workspace code was supplied -> worker (a code means one realm only)
 *   3. staff entry was chosen        -> worker, but incomplete until the code
 *      is given; this outranks the email heuristic, so a worker whose NAME
 *      looks like an email always has a deterministic way in
 *   4. the identifier looks like an email -> owner class
 *   5. otherwise -> incomplete: submit stays disabled and NOTHING is sent
 */
export function resolveEntryRealm({
  identifier,
  workspaceCode,
  staffMode,
}: EntryRealmInput): EntryRealm {
  if (identifier.trim() === "") return "incomplete";
  if (workspaceCode.trim() !== "") return "worker";
  if (staffMode) return "incomplete";
  if (looksLikeEmail(identifier)) return "owner";
  return "incomplete";
}
