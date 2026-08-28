import { createClient } from "@supabase/supabase-js";

// Phase 3C Roles Mutations - shared Owner auth bridge. Leading underscore:
// Vercel does not turn a file/folder starting with `_` into a Serverless
// Function/route - this is a shared module imported by the actual Owner
// route handlers (owner-session.ts, owner-reauth.ts, owner-roles.ts), never
// itself reachable as an endpoint.
//
// The one job of this file: turn a browser-supplied Supabase Owner JWT into
// a SERVER-VERIFIED auth_user_id (and, for step-up, the verified user's own
// email) via a real cryptographic signature check (auth.getUser(jwt)) - per
// the approved trust chain and the prior Owner trust-boundary spike's own
// empirical finding ("auth.getUser(jwt) performs real cryptographic
// signature verification - tampered JWTs and garbage strings both correctly
// rejected"). Nothing downstream of this file ever trusts a client-supplied
// ownerId/workspaceId/authUserId - only the value this module itself
// resolves from a verified JWT.

interface MinimalRequest {
  headers: Record<string, string | string[] | undefined>;
}

export interface VerifiedOwnerAuth {
  authUserId: string;
  email: string;
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function getServiceClient() {
  const url = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !serviceKey) {
    throw new Error("SERVER_CONFIG_MISSING");
  }
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// A SEPARATE, isolated Auth client (anon key, not service_role) - used only
// for signInWithPassword step-up verification in owner-reauth.ts. Never
// shares state with the service client, and its own auth.getUser(jwt) call
// below is likewise made from a throwaway client instance so no session is
// ever persisted or reused server-side (matches the spike's own empirical
// finding: "isolated server-side signInWithPassword ... does not corrupt
// other sessions").
export function getAnonAuthClient() {
  const url = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anonKey) {
    throw new Error("SERVER_CONFIG_MISSING");
  }
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function extractBearerToken(req: MinimalRequest): string | null {
  const raw = headerValue(req.headers.authorization);
  if (!raw || !raw.startsWith("Bearer ")) return null;
  const token = raw.slice("Bearer ".length).trim();
  return token || null;
}

// Real cryptographic JWT verification via Supabase Auth itself - not a
// locally-decoded-and-trusted claim. Returns null for a missing, malformed,
// tampered, or expired token, or for a token whose verified user has no
// email on record (should not happen for a real Supabase Auth user, but
// email is required downstream for the password step-up flow, so this is
// treated as a verification failure rather than silently proceeding with an
// empty string).
export async function verifyOwnerJwt(
  rawToken: string,
): Promise<VerifiedOwnerAuth | null> {
  const client = getServiceClient();
  const { data, error } = await client.auth.getUser(rawToken);
  if (error || !data?.user?.id || !data.user.email) {
    return null;
  }
  return { authUserId: data.user.id, email: data.user.email };
}
