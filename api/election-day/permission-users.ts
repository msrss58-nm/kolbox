// Platform Stage 9 - CLOSED endpoint.
//
// This file used to serve PermissionUser (worker) user management: GET roster,
// POST create, and two POST sub-actions reached via vercel.json rewrites
// (/permission-users-delete, /permission-users-reset-password -> the
// `__pu_action` marker). User management is now Election Owner authority only
// (api/election-day/owner-actions.ts: list/create/delete/reset_permission_user,
// Owner JWT + one-time Owner proof), and the worker-side RPCs this file called
// have no grant left at all (migration 20260916000000).
//
// The file is kept, not deleted, so the public URLs and the rewrites keep a
// defined, fail-closed answer and the Vercel Function count is unchanged. It
// performs no database or auth work of any kind.

interface MinimalRequest {
  method?: string;
  url?: string;
}

interface MinimalResponse {
  status: (code: number) => MinimalResponse;
  json: (body: unknown) => void;
}

function sendError(res: MinimalResponse, status: number, code: string): void {
  res.status(status).json({ error: code });
}

function getQueryParam(req: MinimalRequest, name: string): string | null {
  const rawUrl = req.url ?? "";
  const qIndex = rawUrl.indexOf("?");
  if (qIndex === -1) return null;
  return new URLSearchParams(rawUrl.slice(qIndex + 1)).get(name);
}

export default async function handler(
  req: MinimalRequest,
  res: MinimalResponse,
): Promise<void> {
  const method = req.method ?? "GET";
  const action = getQueryParam(req, "__pu_action");

  // The two aliased URLs only ever accepted POST - keep that method contract.
  if ((action === "delete" || action === "reset-password") && method !== "POST") {
    sendError(res, 405, "METHOD_NOT_ALLOWED");
    return;
  }
  if (!action && method !== "GET" && method !== "POST") {
    sendError(res, 405, "METHOD_NOT_ALLOWED");
    return;
  }

  sendError(res, 403, "USER_MANAGEMENT_OWNER_ONLY");
}
