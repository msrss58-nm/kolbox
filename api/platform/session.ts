import {
  extractPlatformBearerToken,
  verifyPlatformOwnerJwt,
} from "../election-day/_platformAuth.js";

// Platform Stage 2 - PLATFORM OWNER session/context endpoint. GET-only,
// read-only. The single question it answers: "does this Supabase JWT belong
// to the singleton platform owner?" On success it returns the bare
// {platformOwnerId, email} pair and NOTHING else - no voter data, no
// workspace data, no Election Day operational fields, and no Election Owner
// APIs are reachable through it.
//
// A DIFFERENT principal from the Election Owner endpoints under
// /api/election-day/*: this route verifies via _platformAuth.ts's
// verifyPlatformOwnerJwt (getUser -> getClaims/aal2 -> platform_owners row)
// and never via _ownerAuth.ts's verifyOwnerJwt. The two principals must
// never authorize each other.
//
// No Origin check on GET - browsers do not reliably send an Origin header on
// a same-origin simple GET (matches the existing session endpoints in this
// project); this endpoint is read-only with no state-changing side effect,
// so a forged cross-site GET can at most read back {platformOwnerId, email}
// for a JWT the caller already possesses.

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

  if (!process.env.VITE_SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }

  const rawToken = extractPlatformBearerToken(req);
  if (!rawToken) {
    sendError(res, 401, "UNAUTHORIZED");
    return;
  }

  const verified = await verifyPlatformOwnerJwt(rawToken);
  if (!verified) {
    sendError(res, 401, "UNAUTHORIZED");
    return;
  }

  res
    .status(200)
    .json({ platformOwnerId: verified.platformOwnerId, email: verified.email });
}
