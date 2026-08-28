import { extractBearerToken, getServiceClient, verifyOwnerJwt } from "./_ownerAuth";

// Phase 3C Roles Mutations - minimal, read-only Owner-session/context
// endpoint. GET-only. Lets a future frontend (none wired yet - this is
// backend-only proof work) prove: a valid Supabase Owner JWT resolves to a
// recognized Election Owner + workspace. This is a backend bridge, NOT
// Phase-4 Owner onboarding/dashboard work - it returns only the bare
// {ownerId, workspaceId} pair, nothing else.
//
// No Origin check on GET - browsers do not reliably send an Origin header
// on a same-origin simple GET (matches session.ts's own GET handling); this
// endpoint is read-only and carries no state-changing side effect, so a
// forged cross-site GET request can at most read back {ownerId,
// workspaceId} for whatever Owner JWT the caller already possesses - no
// different from what that same JWT could already prove by calling
// Supabase Auth directly.

interface MinimalRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}

interface MinimalResponse {
  status: (code: number) => MinimalResponse;
  json: (body: unknown) => void;
}

function sendError(res: MinimalResponse, status: number, code: string): void {
  res.status(status).json({ error: code });
}

export default async function handler(
  req: MinimalRequest,
  res: MinimalResponse,
): Promise<void> {
  const method = req.method ?? "GET";

  if (method !== "GET") {
    sendError(res, 405, "METHOD_NOT_ALLOWED");
    return;
  }

  const rawToken = extractBearerToken(req);
  if (!rawToken) {
    sendError(res, 401, "UNAUTHORIZED");
    return;
  }

  const verified = await verifyOwnerJwt(rawToken);
  if (!verified) {
    sendError(res, 401, "UNAUTHORIZED");
    return;
  }

  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }

  const { data, error } = await supabase.rpc("election_day_resolve_owner_context", {
    p_auth_user_id: verified.authUserId,
  });

  if (error || !data || (Array.isArray(data) && data.length === 0)) {
    sendError(res, 401, "UNAUTHORIZED");
    return;
  }

  const row = (Array.isArray(data) ? data[0] : data) as {
    owner_id: string;
    workspace_id: string;
  };

  res.status(200).json({ ownerId: row.owner_id, workspaceId: row.workspace_id });
}
