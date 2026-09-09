import { getServiceClient } from "./_ownerAuth.js";

// Platform Stage 2 - shared PLATFORM OWNER auth bridge. Leading underscore:
// Vercel does not turn a file starting with `_` into a Serverless Function,
// so this module adds zero to the Hobby function count - it is imported by
// real route handlers (api/platform/session.ts), never reachable itself.
//
// DELIBERATELY SEPARATE from _ownerAuth.ts's verifyOwnerJwt(). That function
// verifies an ELECTION Owner (a per-workspace principal) and must never be
// able to authorize a Platform Owner, nor the reverse. The only thing shared
// with it is the plumbing (service client + Bearer extraction), never the
// authorization decision. Do not "unify" the two verifiers.

interface MinimalRequest {
  headers: Record<string, string | string[] | undefined>;
}

export interface VerifiedPlatformOwner {
  platformOwnerId: string;
  authUserId: string;
  email: string;
}

// ===========================================================================
// TEMPORARY DIAGNOSTIC - REMOVE ONCE THE PLATFORM ORIGIN IS PROVEN.
// ===========================================================================
// verifyPlatformOwnerJwt below fails closed through seven distinct branches
// that all collapse to the same opaque 401, and it logs nothing - so an
// authorization failure is externally indistinguishable from any other. That
// is correct for production and useless for diagnosis, which is why this
// exists.
//
// WHAT IT EMITS: booleans and one stage label drawn from a fixed enum. It
// never touches the token, claims, user id, email, owner id, project URL, any
// key, any header, any cookie, or an error object - a raw error can carry a
// URL or key fragment, so error text is never logged, only the fact that the
// step failed.
//
// WHERE IT GOES: the runtime log, never the HTTP response. Responses stay
// byte-identical, no diagnostic endpoint is created, and the output is
// readable only by whoever can already read this project's Vercel logs.
//
// Delete this block, the `diag` plumbing inside the function, and the
// `emit(...)` calls in a single dedicated cleanup commit.
type PlatformAuthStage =
  | "serviceClient"
  | "getUser"
  | "userFields"
  | "getClaims"
  | "aal2"
  | "subjectMatch"
  | "ownerRpc"
  | "ownerRowCount"
  | "ownerIdPresent"
  | "ok";

interface PlatformAuthDiag {
  serviceClientCreated: boolean;
  getUserOk: boolean;
  userIdPresent: boolean;
  emailPresent: boolean;
  getClaimsOk: boolean;
  aal2Ok: boolean;
  subjectMatch: boolean;
  ownerRpcOk: boolean;
  ownerRowCountOk: boolean;
  ownerIdPresent: boolean;
}

function newDiag(): PlatformAuthDiag {
  return {
    serviceClientCreated: false,
    getUserOk: false,
    userIdPresent: false,
    emailPresent: false,
    getClaimsOk: false,
    aal2Ok: false,
    subjectMatch: false,
    ownerRpcOk: false,
    ownerRowCountOk: false,
    ownerIdPresent: false,
  };
}

function emit(diag: PlatformAuthDiag, stage: PlatformAuthStage): void {
  // Fixed prefix so the line is greppable in `vercel logs`.
  console.log(`PLATFORM_AUTH_DIAG ${JSON.stringify({ ...diag, failedAt: stage })}`);
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// Local copy rather than an import, so this module's Bearer parsing cannot be
// changed out from under it by an edit to the Election Owner bridge.
export function extractPlatformBearerToken(req: MinimalRequest): string | null {
  const raw = headerValue(req.headers.authorization);
  if (!raw || !raw.startsWith("Bearer ")) return null;
  const token = raw.slice("Bearer ".length).trim();
  return token || null;
}

/**
 * Verify a browser-supplied Supabase JWT as the singleton PLATFORM OWNER.
 *
 * Fail-closed: returns null on ANY failure - missing/malformed/tampered/
 * expired token, revoked or deleted user, an aal1 (non-MFA) session, a
 * missing email, an RPC error, or a caller that is simply not the platform
 * owner. There is no partial success and no "trusted" fallback.
 *
 * All THREE checks are required, in this order:
 *
 * 1. auth.getUser(token) - a live, stateful call to the Auth server.
 * 2. auth.getClaims(token) - signature/exp verification, then aal === "aal2".
 * 3. platform_resolve_owner_context(p_auth_user_id) - the verified id must
 *    match the singleton platform_owners row.
 *
 * ORDER MATTERS: getUser() FIRST, then getClaims(). getClaims() verifies the
 * ES256/JWKS signature and the `exp` claim, but it is STATELESS - it never
 * talks to the Auth server. It was empirically proven to still return valid
 * claims for a REVOKED session AND for a DELETED user for the remainder of
 * the token's lifetime (~3600s). Only getUser() catches revocation and
 * deletion, because only getUser() actually asks the Auth server whether the
 * session and user still exist. Never "optimize away" the getUser() call,
 * and never reorder it after getClaims() - doing so re-opens a ~1-hour
 * window in which a revoked or deleted account still authenticates.
 *
 * aal2 IS NOT AUTHORIZATION. Production Supabase signup is open: any member
 * of the public can self-register an account and enroll their own TOTP
 * factor, reaching aal2 entirely on their own. aal2 therefore only proves
 * "this session completed a second factor", not "this person is privileged".
 * Authority comes exclusively from check 3 - matching the singleton
 * platform_owners row via platform_resolve_owner_context. Removing check 3
 * would hand the platform to anyone with an email address.
 */
export async function verifyPlatformOwnerJwt(
  rawToken: string,
): Promise<VerifiedPlatformOwner | null> {
  // TEMPORARY DIAGNOSTIC plumbing - see the block above this function. Every
  // early return emits one value-free line first; not one authorization
  // decision below is altered by it.
  const diag = newDiag();

  // Unreachable from api/platform/session.ts, which 401s on a missing Bearer
  // before calling this - deliberately left un-emitted rather than inventing
  // a stage label for a state the endpoint cannot produce.
  if (!rawToken) return null;

  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    emit(diag, "serviceClient");
    return null;
  }
  diag.serviceClientCreated = true;

  // CHECK 1 - stateful: catches revoked sessions and deleted users, which
  // getClaims() provably does not. Must stay first.
  const { data: userData, error: userError } = await supabase.auth.getUser(rawToken);
  diag.getUserOk = !userError;
  diag.userIdPresent = Boolean(userData?.user?.id);
  diag.emailPresent = Boolean(userData?.user?.email);
  if (userError || !userData?.user?.id || !userData.user.email) {
    emit(diag, userError ? "getUser" : "userFields");
    return null;
  }
  const authUserId = userData.user.id;
  const email = userData.user.email;

  // CHECK 2 - cryptographic signature + exp, and the MFA assurance level.
  const { data: claimsData, error: claimsError } =
    await supabase.auth.getClaims(rawToken);
  diag.getClaimsOk = !claimsError && Boolean(claimsData?.claims);
  if (claimsError || !claimsData?.claims) {
    emit(diag, "getClaims");
    return null;
  }
  diag.aal2Ok = claimsData.claims.aal === "aal2";
  if (claimsData.claims.aal !== "aal2") {
    emit(diag, "aal2");
    return null;
  }
  // The claims must describe the SAME identity getUser() just verified - a
  // mismatch means the two calls disagree, which is never a valid state.
  diag.subjectMatch = claimsData.claims.sub === authUserId;
  if (claimsData.claims.sub !== authUserId) {
    emit(diag, "subjectMatch");
    return null;
  }

  // CHECK 3 - the only check that confers authority. p_auth_user_id is the
  // SERVER-VERIFIED id from check 1, never anything client-supplied.
  const { data: ctxData, error: ctxError } = await supabase.rpc(
    "platform_resolve_owner_context",
    { p_auth_user_id: authUserId },
  );

  diag.ownerRpcOk = !ctxError && Boolean(ctxData);
  if (ctxError || !ctxData) {
    emit(diag, "ownerRpc");
    return null;
  }
  // `returns table (platform_owner_id uuid)` normally arrives as an array;
  // handle a scalar/object shape defensively too, the same way the former
  // owner-session.ts did. Exactly one row - a 0-row or multi-row result is a
  // failure, never a "pick the first one" situation.
  diag.ownerRowCountOk = !(Array.isArray(ctxData) && ctxData.length !== 1);
  if (Array.isArray(ctxData) && ctxData.length !== 1) {
    emit(diag, "ownerRowCount");
    return null;
  }
  const row = (Array.isArray(ctxData) ? ctxData[0] : ctxData) as {
    platform_owner_id?: unknown;
  };
  const platformOwnerId =
    typeof row?.platform_owner_id === "string" ? row.platform_owner_id : "";
  diag.ownerIdPresent = Boolean(platformOwnerId);
  if (!platformOwnerId) {
    emit(diag, "ownerIdPresent");
    return null;
  }

  emit(diag, "ok");
  return { platformOwnerId, authUserId, email };
}
