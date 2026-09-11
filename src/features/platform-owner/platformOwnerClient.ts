/**
 * Platform Stage 2: pure fetch wrapper around the Platform Owner session
 * endpoint (`GET /api/platform/session`). Mirrors
 * `electionDayOwnerClient.ts`'s conventions exactly - a small discriminated
 * union per call, no HTTP status ever leaking past this module, no
 * React/zustand dependency, and the access token supplied explicitly by the
 * caller (this module never reads any Supabase client itself).
 *
 * The SERVER is the authority. It independently verifies the JWT signature,
 * requires `claims.aal === "aal2"`, and requires membership of the singleton
 * `platform_owners` row. A `200` from here is the ONLY thing that may unlock
 * the console - client-side state (a cached owner object, a locally-decoded
 * AAL claim) is never sufficient on its own.
 */

const PLATFORM_SESSION_ENDPOINT = "/api/platform/session";

export interface PlatformOwnerContext {
  platformOwnerId: string;
  email: string;
}

export type PlatformOwnerSessionResult =
  | { status: "ok"; context: PlatformOwnerContext }
  /** 401 - not a Platform Owner, not `aal2`, or a bad/revoked token. */
  | { status: "unauthorized" }
  /** Transport failure, 405, 500, or an unparseable/malformed body. */
  | { status: "error" };

function isPlatformOwnerContext(value: unknown): value is PlatformOwnerContext {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.platformOwnerId === "string" && typeof v.email === "string";
}

export async function fetchPlatformOwnerSession(
  accessToken: string,
): Promise<PlatformOwnerSessionResult> {
  try {
    const res = await fetch(PLATFORM_SESSION_ENDPOINT, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 200) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { status: "error" };
      }
      return isPlatformOwnerContext(body)
        ? { status: "ok", context: body }
        : { status: "error" };
    }
    if (res.status === 401) return { status: "unauthorized" };
    return { status: "error" };
  } catch {
    return { status: "error" };
  }
}

/* ==========================================================================
 * Stage 3B - approve a new Election Owner.
 *
 * POSTs to the SAME endpoint as the session read above, with an `op`
 * multiplex. Not a stylistic choice: this project is at 12/12 Vercel Hobby
 * Functions with no per-project exclusion mechanism, so a dedicated file is
 * impossible. Keeping the operation on the Platform principal's own endpoint
 * also keeps it away from the Election Day handlers, whose Origin allow-list
 * would reject this origin outright.
 *
 * The response's activationLink is a ONE-TIME credential. It is returned to
 * the caller's own control flow and never stored, cached, or logged here.
 * ========================================================================== */

const PLATFORM_APPROVE_OWNER_OP = "create_owner_access";

export interface CreatedOwnerAccess {
  pendingId: string;
  expiresAt: string | null;
  alreadyExisted: boolean;
  /** Null when the approval succeeded but link generation did not - the
   * approval still stands and a link can be regenerated. */
  activationLink: string | null;
}

export type CreateOwnerAccessResult =
  | { status: "ok"; access: CreatedOwnerAccess }
  /** `orphanedAuthUserId`: the approval failed AND its compensating Auth
   * delete could not be confirmed (AUTH_CLEANUP_INCOMPLETE). Re-approving the
   * same address re-uses that account rather than creating a second one. */
  | { status: "error"; code: string; orphanedAuthUserId?: string };

export async function createOwnerAccess(
  accessToken: string,
  input: { name: string; email: string; phone?: string },
): Promise<CreateOwnerAccessResult> {
  try {
    const res = await fetch(PLATFORM_SESSION_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        op: PLATFORM_APPROVE_OWNER_OP,
        name: input.name,
        email: input.email,
        ...(input.phone ? { phone: input.phone } : {}),
      }),
    });

    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }

    if (res.status === 201) {
      const v = parsed as Record<string, unknown> | null;
      if (!v || typeof v.pendingId !== "string") {
        return { status: "error", code: "SERVER_ERROR" };
      }
      return {
        status: "ok",
        access: {
          pendingId: v.pendingId,
          expiresAt: typeof v.expiresAt === "string" ? v.expiresAt : null,
          alreadyExisted: v.alreadyExisted === true,
          activationLink: typeof v.activationLink === "string" ? v.activationLink : null,
        },
      };
    }

    const code =
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { error?: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : "SERVER_ERROR";
    const orphan =
      rec(parsed) && str((parsed as Record<string, unknown>).orphanedAuthUserId);
    return orphan
      ? { status: "error", code, orphanedAuthUserId: orphan }
      : { status: "error", code };
  } catch {
    return { status: "error", code: "SERVER_ERROR" };
  }
}

/* ==========================================================================
 * Stage 4B - Multi-Entity Owner seat, workspace assignments, and the two
 * DURABLE Auth-cleanup queues.
 *
 * Same endpoint and same `op` multiplex as everything above (12/12 Vercel
 * Hobby Functions - see the Stage 3B block's note).
 *
 * CASING. `?op=multi_entity_state` is the one response on this surface that
 * reaches the browser in snake_case: api/platform/session.ts passes the RPC's
 * jsonb through verbatim rather than re-shaping it. Every mapper below is the
 * single place that boundary is crossed, so nothing above this module ever
 * sees a snake_case key - the same split electionDayOwnerClient.ts already
 * uses for `login_code`.
 *
 * DEFENSIVE BY DEFAULT. Each field is validated, never cast through. A
 * malformed entry is dropped rather than surfaced half-built, and a missing or
 * non-array queue normalises to [] - the UI must never have to tell "none"
 * apart from "the server did not say".
 * ========================================================================== */

const MULTI_ENTITY_STATE_OP = "multi_entity_state";

export interface MultiEntitySeat {
  authUserId: string;
  name: string;
  email: string;
  phone: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface MultiEntityWorkspace {
  workspaceId: string;
  name: string;
  /** The only guaranteed-unique human-readable discriminator between two
   * workspaces - `election_workspaces.name` carries no uniqueness constraint.
   * A tenant SELECTOR, not a secret (see the RPC comment). */
  loginCode: string;
  electionEndAt: string | null;
  /** Derived server-side from `election_end_at > now()`, never stored. */
  isActive: boolean;
  isAssigned: boolean;
  assignedAt: string | null;
}

/** An Auth account displaced from the seat by a replacement and never purged. */
export interface PendingAuthCleanup {
  previousAuthUserId: string;
  replacedAt: string | null;
  failureCount: number;
  lastCleanupAttemptAt: string | null;
}

/** An Auth account minted for a provisioning attempt that never became the
 * seat. A DIFFERENT business fact from the above, with a different purge op -
 * the two are deliberately never merged. */
export interface PendingProvisioningOrphan {
  authUserId: string;
  mintedAt: string | null;
  attemptedEmail: string | null;
  failureCount: number;
  lastCleanupAttemptAt: string | null;
}

export interface MultiEntityState {
  seat: MultiEntitySeat | null;
  workspaces: MultiEntityWorkspace[];
  pendingAuthCleanup: PendingAuthCleanup[];
  pendingProvisioningOrphans: PendingProvisioningOrphan[];
}

export interface ProvisionedMultiEntityOwner {
  seatAuthUserId: string;
  replaced: boolean;
  previousAuthUserId: string | null;
  /** The one-time password-setting link. Null when the seat was written but
   * link generation failed - the seat still stands and a new link can be
   * minted by re-running the operation. NEVER persisted anywhere. */
  passwordLink: string | null;
}

export interface AuthCleanupOutcome {
  deleted: boolean;
  auditRecorded: boolean;
  alreadyCompleted: boolean;
  /** `AUTH_CLEANUP_AUDIT_WRITE_FAILED` - the delete may already have happened
   * but the audit write did not, so the entry stays listed and a retry
   * converges. Not an error: the response is a 200. */
  warning: string | null;
}

/** Uniform result for every Stage 4B call. `unauthorized` is split out from
 * `error` because it is the one code the caller must answer by re-resolving
 * the Platform Owner session rather than by showing a message. */
export type MultiEntityResult<T> =
  | { status: "ok"; data: T }
  | { status: "unauthorized" }
  | {
      status: "error";
      code: string;
      /** Which live linkage still holds the account (409 AUTH_USER_STILL_HELD). */
      heldBy?: string | null;
      /** Provisioning failed AND its compensating Auth delete could not be
       * confirmed, so an account may remain. Surfaced, never swallowed. */
      orphanedAuthUserId?: string;
    };

/* ---- shape guards -------------------------------------------------------- */

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function mapSeat(v: unknown): MultiEntitySeat | null {
  const o = rec(v);
  const id = o && str(o.auth_user_id);
  if (!o || !id) return null;
  return {
    authUserId: id,
    name: str(o.name) ?? "",
    email: str(o.email) ?? "",
    phone: str(o.phone),
    createdAt: str(o.created_at),
    updatedAt: str(o.updated_at),
  };
}

function mapWorkspaces(v: unknown): MultiEntityWorkspace[] {
  if (!Array.isArray(v)) return [];
  const out: MultiEntityWorkspace[] = [];
  for (const raw of v) {
    const o = rec(raw);
    const id = o && str(o.workspace_id);
    if (!o || !id) continue; // drop a malformed row rather than render half of it
    out.push({
      workspaceId: id,
      name: str(o.name) ?? "",
      loginCode: str(o.login_code) ?? "",
      electionEndAt: str(o.election_end_at),
      isActive: o.is_active === true,
      isAssigned: o.is_assigned === true,
      assignedAt: str(o.assigned_at),
    });
  }
  return out;
}

function mapPendingCleanup(v: unknown): PendingAuthCleanup[] {
  if (!Array.isArray(v)) return [];
  const out: PendingAuthCleanup[] = [];
  for (const raw of v) {
    const o = rec(raw);
    const id = o && str(o.previous_auth_user_id);
    if (!o || !id) continue;
    out.push({
      previousAuthUserId: id,
      replacedAt: str(o.replaced_at),
      failureCount: num(o.failure_count),
      lastCleanupAttemptAt: str(o.last_cleanup_attempt_at),
    });
  }
  return out;
}

function mapPendingOrphans(v: unknown): PendingProvisioningOrphan[] {
  if (!Array.isArray(v)) return [];
  const out: PendingProvisioningOrphan[] = [];
  for (const raw of v) {
    const o = rec(raw);
    const id = o && str(o.auth_user_id);
    if (!o || !id) continue;
    out.push({
      authUserId: id,
      mintedAt: str(o.minted_at),
      attemptedEmail: str(o.attempted_email),
      failureCount: num(o.failure_count),
      lastCleanupAttemptAt: str(o.last_cleanup_attempt_at),
    });
  }
  return out;
}

/* ---- transport ----------------------------------------------------------- */

async function parseJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Reads `{error}` off a failure body. Only the fixed server code is ever
 * read - the server never returns raw Postgres/GoTrue text, and this never
 * falls back to a status line or a message string. */
function failure<T>(status: number, body: unknown): MultiEntityResult<T> {
  if (status === 401) return { status: "unauthorized" };
  const o = rec(body);
  const code = (o && str(o.error)) ?? "SERVER_ERROR";
  const out: MultiEntityResult<T> = { status: "error", code };
  if (o && "heldBy" in o) out.heldBy = str(o.heldBy);
  const orphan = o && str(o.orphanedAuthUserId);
  if (orphan) out.orphanedAuthUserId = orphan;
  return out;
}

async function postOp<T>(
  accessToken: string,
  body: Record<string, unknown>,
  ok: (parsed: unknown) => T | null,
  okStatus = 200,
): Promise<MultiEntityResult<T>> {
  try {
    const res = await fetch(PLATFORM_SESSION_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });
    const parsed = await parseJson(res);
    if (res.status !== okStatus) return failure<T>(res.status, parsed);
    const data = ok(parsed);
    return data === null
      ? { status: "error", code: "SERVER_ERROR" }
      : { status: "ok", data };
  } catch {
    return { status: "error", code: "SERVER_ERROR" };
  }
}

/* ---- operations ---------------------------------------------------------- */

export async function fetchMultiEntityState(
  accessToken: string,
): Promise<MultiEntityResult<MultiEntityState>> {
  try {
    const res = await fetch(
      `${PLATFORM_SESSION_ENDPOINT}?op=${encodeURIComponent(MULTI_ENTITY_STATE_OP)}`,
      { method: "GET", headers: { authorization: `Bearer ${accessToken}` } },
    );
    const parsed = await parseJson(res);
    if (res.status !== 200) return failure<MultiEntityState>(res.status, parsed);
    const o = rec(parsed);
    if (!o) return { status: "error", code: "SERVER_ERROR" };
    return {
      status: "ok",
      data: {
        seat: mapSeat(o.seat),
        workspaces: mapWorkspaces(o.workspaces),
        pendingAuthCleanup: mapPendingCleanup(o.pending_auth_cleanup),
        pendingProvisioningOrphans: mapPendingOrphans(o.pending_provisioning_orphans),
      },
    };
  } catch {
    return { status: "error", code: "SERVER_ERROR" };
  }
}

/** Creates or replaces the singleton seat. Body keys are EXACTLY
 * `name`/`email`/`phone` - the server rejects any extra key with a 400, and
 * `phone` is omitted rather than sent empty. */
export async function provisionMultiEntityOwner(
  accessToken: string,
  input: { name: string; email: string; phone?: string },
): Promise<MultiEntityResult<ProvisionedMultiEntityOwner>> {
  return postOp(
    accessToken,
    {
      op: "provision_multi_entity_owner",
      name: input.name,
      email: input.email,
      ...(input.phone ? { phone: input.phone } : {}),
    },
    (parsed) => {
      const o = rec(parsed);
      const id = o && str(o.seatAuthUserId);
      if (!o || !id) return null;
      return {
        seatAuthUserId: id,
        replaced: o.replaced === true,
        previousAuthUserId: str(o.previousAuthUserId),
        passwordLink: str(o.activationLink),
      };
    },
    201,
  );
}

export async function assignWorkspace(
  accessToken: string,
  workspaceId: string,
): Promise<MultiEntityResult<{ alreadyAssigned: boolean }>> {
  return postOp(accessToken, { op: "assign_workspace", workspaceId }, (parsed) => {
    const o = rec(parsed);
    return { alreadyAssigned: o?.already_assigned === true };
  });
}

export async function unassignWorkspace(
  accessToken: string,
  workspaceId: string,
): Promise<MultiEntityResult<{ removed: boolean }>> {
  return postOp(accessToken, { op: "unassign_workspace", workspaceId }, (parsed) => {
    const o = rec(parsed);
    return { removed: o?.removed === true };
  });
}

function mapCleanupOutcome(parsed: unknown): AuthCleanupOutcome | null {
  const o = rec(parsed);
  if (!o) return null;
  return {
    // Two different field names for the same fact, because the two ops are
    // deliberately separate contracts rather than one widened one.
    deleted: o.previousAccountDeleted === true || o.accountDeleted === true,
    auditRecorded: o.auditRecorded === true,
    alreadyCompleted: o.alreadyCompleted === true,
    warning: str(o.warning),
  };
}

/** DESTRUCTIVE. Purges an Auth account displaced from the seat by a
 * replacement. Body key is exactly `previousAuthUserId`. */
export async function purgeReplacedAuthUser(
  accessToken: string,
  previousAuthUserId: string,
): Promise<MultiEntityResult<AuthCleanupOutcome>> {
  return postOp(
    accessToken,
    { op: "purge_replaced_auth_user", previousAuthUserId },
    mapCleanupOutcome,
  );
}

/** DESTRUCTIVE. Purges an Auth account left behind by a FAILED provisioning
 * attempt. Body key is exactly `authUserId` - the server rejects this op if
 * the request carries the other op key. */
export async function purgeProvisioningOrphan(
  accessToken: string,
  authUserId: string,
): Promise<MultiEntityResult<AuthCleanupOutcome>> {
  return postOp(
    accessToken,
    { op: "purge_provisioning_orphan", authUserId },
    mapCleanupOutcome,
  );
}

/* ==========================================================================
 * Stage 8B - Election Owner approvals: list + re-issue.
 *
 * Same endpoint and op multiplex. `?op=owner_access` returns the RPC's
 * snake_case rows inside `{approvals}`; they are mapped here and nowhere else.
 * A re-issue never creates an Auth user - it returns a new one-time link for
 * the approval's existing account (and, for an expired approval, a renewed
 * window). The link is a credential-grade value: returned to the caller's own
 * control flow only, never stored here.
 * ========================================================================== */

export type OwnerAccessState = "active" | "expired" | "consumed";

export interface OwnerAccessApproval {
  pendingId: string;
  name: string;
  email: string;
  phone: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  consumedAt: string | null;
  state: OwnerAccessState;
  /** Present only once the Owner has provisioned their workspace. */
  workspaceName: string | null;
}

export interface ReissuedOwnerAccess {
  pendingId: string;
  expiresAt: string | null;
  /** True when an EXPIRED approval received a new window. */
  renewed: boolean;
  /** Null when the re-issue succeeded but link generation did not - the op is
   * safely repeatable. */
  activationLink: string | null;
}

const OWNER_ACCESS_STATES = new Set<string>(["active", "expired", "consumed"]);

function mapApprovals(v: unknown): OwnerAccessApproval[] {
  const list = rec(v)?.approvals;
  if (!Array.isArray(list)) return [];
  const out: OwnerAccessApproval[] = [];
  for (const raw of list) {
    const o = rec(raw);
    const id = o && str(o.pending_id);
    const state = o && str(o.state);
    // Drop a malformed row rather than render half of it (or offer an action
    // on a state the server did not state).
    if (!o || !id || !state || !OWNER_ACCESS_STATES.has(state)) continue;
    out.push({
      pendingId: id,
      name: str(o.name) ?? "",
      email: str(o.email) ?? "",
      phone: str(o.phone),
      createdAt: str(o.created_at),
      expiresAt: str(o.expires_at),
      consumedAt: str(o.consumed_at),
      state: state as OwnerAccessState,
      workspaceName: str(o.workspace_name),
    });
  }
  return out;
}

export async function fetchOwnerAccess(
  accessToken: string,
): Promise<MultiEntityResult<OwnerAccessApproval[]>> {
  try {
    const res = await fetch(`${PLATFORM_SESSION_ENDPOINT}?op=owner_access`, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const parsed = await parseJson(res);
    if (res.status !== 200) return failure<OwnerAccessApproval[]>(res.status, parsed);
    if (!rec(parsed)) return { status: "error", code: "SERVER_ERROR" };
    return { status: "ok", data: mapApprovals(parsed) };
  } catch {
    return { status: "error", code: "SERVER_ERROR" };
  }
}

/** Body key is exactly `pendingId` - the server rejects any other key. */
export async function reissueOwnerAccess(
  accessToken: string,
  pendingId: string,
): Promise<MultiEntityResult<ReissuedOwnerAccess>> {
  return postOp(accessToken, { op: "reissue_owner_access", pendingId }, (parsed) => {
    const o = rec(parsed);
    const id = o && str(o.pendingId);
    if (!o || !id) return null;
    return {
      pendingId: id,
      expiresAt: str(o.expiresAt),
      renewed: o.renewed === true,
      activationLink: str(o.activationLink),
    };
  });
}
