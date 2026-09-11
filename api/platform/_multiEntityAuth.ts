import { getServiceClient } from "../election-day/_ownerAuth.js";

// Platform Stage 5 - MULTI-ENTITY OWNER auth bridge. Leading underscore:
// Vercel does not turn a file starting with `_` into a Serverless Function,
// so this module adds zero to the Hobby function count - it is imported by
// _multiEntitySession.ts (reached through api/platform/session.ts's `me_op`
// partition), never reachable itself.
//
// DELIBERATELY SEPARATE from both existing verifiers:
//   - _ownerAuth.ts::verifyOwnerJwt       (Election Owner, aal1, per-workspace)
//   - _platformAuth.ts::verifyPlatformOwnerJwt (Platform Owner, aal2)
// It mirrors the Platform Owner verifier's PATTERN (same three checks, same
// order, same reasons - see that file's doc comment for the empirical findings
// behind them) but shares none of its CODE or its authorization decision. The
// only thing shared is the service-client plumbing. Do not "unify" verifiers:
// a change to one principal's rules must never silently change another's.

interface MinimalRequest {
  headers: Record<string, string | string[] | undefined>;
}

export interface VerifiedMultiEntityOwner {
  authUserId: string;
  email: string;
  name: string;
}

/** Why a token was refused. Never returned to the client (every refusal is the
 * same generic 401), only logged server-side as a category - no ids, no
 * tokens, no emails. `config` and `rpc_error` are server faults (500). */
export type MultiEntityDenyReason =
  | "no_token"
  | "config"
  | "getuser"
  | "claims"
  | "aal"
  | "sub_mismatch"
  | "not_seat"
  | "rpc_error";

export type MultiEntityVerification =
  | { ok: true; owner: VerifiedMultiEntityOwner }
  | { ok: false; reason: MultiEntityDenyReason };

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// Local copy rather than an import, so this principal's Bearer parsing cannot
// be changed out from under it by an edit to either other bridge.
export function extractMultiEntityBearerToken(req: MinimalRequest): string | null {
  const raw = headerValue(req.headers.authorization);
  if (!raw || !raw.startsWith("Bearer ")) return null;
  const token = raw.slice("Bearer ".length).trim();
  return token || null;
}

const deny = (reason: MultiEntityDenyReason): MultiEntityVerification => ({
  ok: false,
  reason,
});

/**
 * Verify a browser-supplied Supabase JWT as the CURRENT, EXCLUSIVE
 * Multi-Entity Owner.
 *
 * Fail-closed: anything other than all three checks passing is a refusal.
 *
 * 1. auth.getUser(token) - a live, stateful call to the Auth server. MUST be
 *    first: getClaims() is stateless and was empirically proven (Platform
 *    Stage 0a/2) to keep accepting a REVOKED session or a DELETED user for
 *    the token's remaining lifetime. Only getUser() catches those.
 * 2. auth.getClaims(token) - signature + exp, then aal === "aal2", then
 *    claims.sub === the id getUser() just verified.
 * 3. multi_entity_resolve_owner_context(verified id) - the ONLY check that
 *    confers authority. It requires the id to hold the singleton seat right
 *    now AND to hold no Platform/Election Owner role (D-8 hardening).
 *
 * aal2 IS NOT AUTHORIZATION. Production signup is open, so anyone can reach
 * aal2 on their own account. Nothing here reads email, user_metadata,
 * app_metadata, the URL, or any client-supplied role/workspace - the email
 * returned is display metadata only.
 */
export async function verifyMultiEntityOwnerJwt(
  rawToken: string,
): Promise<MultiEntityVerification> {
  if (!rawToken) return deny("no_token");

  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    return deny("config");
  }

  try {
    // CHECK 1 - stateful. Must stay first.
    const { data: userData, error: userError } = await supabase.auth.getUser(rawToken);
    if (userError || !userData?.user?.id || !userData.user.email) {
      return deny("getuser");
    }
    const authUserId = userData.user.id;
    const email = userData.user.email;

    // CHECK 2 - signature/exp, MFA assurance, identity agreement.
    const { data: claimsData, error: claimsError } =
      await supabase.auth.getClaims(rawToken);
    if (claimsError || !claimsData?.claims) return deny("claims");
    if (claimsData.claims.aal !== "aal2") return deny("aal");
    if (claimsData.claims.sub !== authUserId) return deny("sub_mismatch");

    // CHECK 3 - the only authority. p_auth_user_id is the SERVER-VERIFIED id
    // from check 1, never anything client-supplied.
    const { data: ctxData, error: ctxError } = await supabase.rpc(
      "multi_entity_resolve_owner_context",
      { p_auth_user_id: authUserId },
    );
    if (ctxError) {
      const unauthorized = (ctxError.message ?? "")
        .toUpperCase()
        .includes("UNAUTHORIZED");
      return deny(unauthorized ? "not_seat" : "rpc_error");
    }
    // Exactly one row. A 0-row or multi-row result is a refusal, never a
    // "pick the first one" situation.
    if (!ctxData || (Array.isArray(ctxData) && ctxData.length !== 1)) {
      return deny("not_seat");
    }
    const row = (Array.isArray(ctxData) ? ctxData[0] : ctxData) as {
      auth_user_id?: unknown;
      name?: unknown;
    };
    if (row?.auth_user_id !== authUserId || typeof row.name !== "string") {
      return deny("not_seat");
    }

    return { ok: true, owner: { authUserId, email, name: row.name } };
  } catch {
    // A transport-level throw is a server fault, never a partial success.
    return deny("rpc_error");
  }
}
