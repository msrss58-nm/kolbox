import { createHash, randomBytes } from "node:crypto";
import {
  extractBearerToken,
  getAnonAuthClient,
  getServiceClient,
  verifyOwnerJwt,
} from "../election-day/_ownerAuth.js";

// Budget Stage 3 - the ONE dedicated Budget endpoint (it takes the Vercel
// Hobby function slot freed by folding clear-voters.ts into import-voters.ts).
// No Budget logic lives in any Election Day endpoint, and no Election Day
// logic lives here.
//
// POST /api/budget/actions            body { op, args }   - PermissionUser
//      (HttpOnly __Host-kb_ed_session cookie, the same worker session)
// POST /api/budget/actions?principal=owner  body { op, args } - Election Owner
//      (Authorization: Bearer <Supabase JWT>, cryptographically verified)
//
// The handler never authorizes anything itself and never forwards a client
// actor/workspace/role: it hashes the cookie (or verifies the Owner JWT) and
// calls exactly one of two service_role-only dispatchers,
//   budget_dispatch_worker(session_hash, op, args)
//   budget_dispatch_owner(auth_user_id, op, args)
// which authenticate, lock the workspace, check EFFECTIVE Budget entitlement
// and the op's permission, and run the op against the actor's own workspace
// only (migrations 20260917000000..20260917020000).
//
// The one op handled here rather than in SQL is the bank-detail STEP-UP
// (op "stepup"): it re-verifies the caller's password with the SAME
// authoritative mechanism as login (workers: the shared PermissionUser bcrypt
// check inside budget_stepup_mint_worker; the Owner: Supabase Auth
// signInWithPassword, then the existing election_day_owner_reauth), is rate
// limited per actor and per IP, audits every failure, and returns a random
// one-time proof ONCE. Only the proof's sha256 is ever stored; the bank ops
// receive the raw proof from the client and this handler replaces it with its
// hash before the dispatcher sees it.

const SESSION_COOKIE_NAME = "__Host-kb_ed_session";
const DEFAULT_PRODUCTION_ORIGIN = "https://kolbox-gamma.vercel.app";
const ALLOWED_BODY_KEYS = new Set<string>(["op", "args"]);
const MAX_STEPUP_ATTEMPTS_PER_WINDOW = 10;
const MAX_IP_ATTEMPTS_PER_WINDOW = 100;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const OP_RE = /^[a-z_]{2,40}$/;
/** Ops whose args carry a step-up proof. */
const PROOF_OPS = new Set<string>(["reveal_supplier_bank", "set_supplier_bank"]);
/** Ops only this handler may call (inside the step-up flow) - never a client. */
const INTERNAL_OPS = new Set<string>(["stepup_check", "record_stepup_failure"]);

/** Business error codes the dispatchers raise on purpose - anything else is a
 * generic SERVER_ERROR, so no raw Postgres text ever reaches the client. */
const ERROR_STATUS: Record<string, number> = {
  UNAUTHORIZED: 401,
  MODULE_NOT_ENABLED: 403,
  FORBIDDEN: 403,
  STEPUP_REQUIRED: 403,
  NOT_FOUND: 404,
  UNKNOWN_OP: 400,
  INVALID_INPUT: 400,
  STALE_VERSION: 409,
  DUPLICATE_NAME: 409,
  DUPLICATE_TAX_ID: 409,
  CATEGORY_IN_USE: 409,
  REORDER_ID_MISMATCH: 409,
  ORIGINAL_LOCKED: 409,
  AMOUNT_BELOW_ZERO: 409,
  INSUFFICIENT_PLAN: 409,
  SUPPLIER_INACTIVE: 409,
  CATEGORY_INACTIVE: 409,
  SOURCE_INACTIVE: 409,
  EXPENSE_LOCKED: 409,
  EXPENSE_INCOMPLETE: 409,
  EXPENSE_NOT_PAYABLE: 409,
  EXPENSE_NOT_SUBMITTABLE: 409,
  INVALID_TRANSITION: 409,
  REASON_REQUIRED: 409,
  ALLOCATION_REQUIRED: 409,
  TOTAL_REQUIRED: 409,
  ALLOCATION_FROZEN: 409,
  ALLOCATION_HAS_PAYMENTS: 409,
  ALLOCATION_HAS_PARTY_WORKFLOW: 409,
  ALLOCATION_BELOW_PAID: 409,
  ALLOCATIONS_EXCEED_TOTAL: 409,
  TOTAL_BELOW_PAID: 409,
  PAYMENTS_EXIST: 409,
  PAYMENT_EXCEEDS_ALLOCATION: 409,
  PAYMENT_ALREADY_VOIDED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  PARTY_REFERENCE_REQUIRED: 409,
  NOT_A_PARTY_ALLOCATION: 409,
  PREAPPROVAL_REQUIRED: 409,
  PREAPPROVAL_LOCKED: 409,
  SUBMISSION_NOT_SENT: 409,
  REFERENCE_LOCKED: 409,
  AUTHORIZED_EXCEEDS_REQUEST: 409,
  SOURCE_KIND_LOCKED: 409,
  CLOSE_BLOCKED: 409,
};

interface MinimalRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  cookies?: Record<string, string>;
}

interface MinimalResponse {
  status: (code: number) => MinimalResponse;
  json: (body: unknown) => void;
}

interface RpcError {
  message?: string;
  code?: string;
  details?: string | null;
}

type ServiceClient = ReturnType<typeof getServiceClient>;

function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function toPgBytea(hexDigest: string): string {
  return "\\x" + hexDigest;
}

function allowedOrigins(): Set<string> {
  const origins = new Set<string>([
    process.env.SESSION_ALLOWED_ORIGIN ?? DEFAULT_PRODUCTION_ORIGIN,
  ]);
  if (process.env.VERCEL_ENV !== "production") {
    origins.add("http://localhost:5173");
  }
  return origins;
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// IP is accounting-only input to the rate-limit bucket - never an identity.
function clientIp(req: MinimalRequest): string | null {
  const raw = headerValue(req.headers["x-forwarded-for"]);
  if (!raw) return null;
  return raw.split(",")[0]?.trim() || null;
}

function sendError(res: MinimalResponse, status: number, code: string, extra?: Record<string, unknown>): void {
  res.status(status).json({ error: code, ...(extra ?? {}) });
}

function isOwnerPrincipal(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url, "http://localhost").searchParams.get("principal") === "owner";
  } catch {
    return false;
  }
}

/** Maps a dispatcher error to a fixed public code. Raw Postgres text never
 * leaves this function: only allow-listed business codes pass through, plus a
 * few structural SQLSTATEs mapped to generic codes. */
function sendRpcError(res: MinimalResponse, error: RpcError): void {
  const message = error.message ?? "";
  const status = ERROR_STATUS[message];
  if (status) {
    const extra: Record<string, unknown> = {};
    const detail = typeof error.details === "string" ? error.details : "";
    if (message === "CLOSE_BLOCKED" && /^[A-Z_,]+$/.test(detail)) {
      extra.blockers = detail.split(",");
    } else if (message === "INVALID_INPUT" && /^[A-Za-z]{1,40}$/.test(detail)) {
      extra.field = detail;
    } else if (message === "DUPLICATE_TAX_ID" && UUID_RE.test(detail)) {
      extra.existingSupplierId = detail;
    } else if (message === "NOT_FOUND" && /^[a-z]{1,20}$/.test(detail)) {
      extra.entity = detail;
    }
    sendError(res, status, message, extra);
    return;
  }
  switch (error.code) {
    case "23514": // check_violation
    case "22P02": // invalid_text_representation
    case "22003": // numeric_value_out_of_range
    case "22007":
    case "22008":
      sendError(res, 400, "INVALID_INPUT");
      return;
    case "23505":
      sendError(res, 409, "DUPLICATE");
      return;
    case "23503":
      sendError(res, 404, "NOT_FOUND");
      return;
    case "40001":
    case "40P01":
      sendError(res, 409, "RETRY");
      return;
    default:
      sendError(res, 500, "SERVER_ERROR");
  }
}

async function registerAttempts(
  supabase: ServiceClient,
  actorBucket: string,
  ipBucket: string | null,
): Promise<"ok" | "limited" | "error"> {
  const [actorResult, ipResult] = await Promise.all([
    supabase.rpc("election_day_register_login_attempt", { p_bucket_key: actorBucket }),
    ipBucket
      ? supabase.rpc("election_day_register_login_attempt", { p_bucket_key: ipBucket })
      : Promise.resolve({ data: 0, error: null }),
  ]);
  if (actorResult.error || ipResult.error) return "error";
  const actorAttempts = (actorResult.data ?? 0) as number;
  const ipAttempts = (ipResult.data ?? 0) as number;
  return actorAttempts > MAX_STEPUP_ATTEMPTS_PER_WINDOW || ipAttempts > MAX_IP_ATTEMPTS_PER_WINDOW
    ? "limited"
    : "ok";
}

type Dispatch = (op: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: RpcError | null }>;

/** op "probe": the navigation check ("may this session use Budget?"). A
 * workspace without Budget, or a role without budget.view, is a normal answer
 * here - 200 with the reason - so a shell can ask on every mount without an
 * error response. It grants nothing: every real op is re-authorized. */
async function handleProbe(res: MinimalResponse, dispatch: Dispatch): Promise<void> {
  const { data, error } = await dispatch("session", {});
  if (error && (error.message === "MODULE_NOT_ENABLED" || error.message === "FORBIDDEN")) {
    res.status(200).json({ data: { unavailable: error.message } });
    return;
  }
  if (error) {
    sendRpcError(res, error);
    return;
  }
  res.status(200).json({ data: { session: data } });
}

/** Step-up: validate -> authorize (stepup_check) -> rate limit -> verify the
 * password with the principal's authoritative mechanism -> mint one proof. */
async function handleStepUp(
  req: MinimalRequest,
  res: MinimalResponse,
  args: Record<string, unknown>,
  dispatch: Dispatch,
  mint: (password: string, kind: string, supplierId: string, proofHash: string, action: string) =>
    Promise<"ok" | "invalid_password" | RpcError>,
  /** The SAME rate-limit namespace as the principal's existing reauth
   * endpoint (reauth.ts / owner-reauth.ts), so Budget adds no extra guesses. */
  buckets: { prefix: string; actorKey: (actorId: string) => string },
  supabase: ServiceClient,
): Promise<void> {
  const keys = Object.keys(args);
  const kind = typeof args.kind === "string" ? args.kind : "";
  const supplierId = typeof args.supplierId === "string" ? args.supplierId : "";
  const password = typeof args.password === "string" ? args.password : "";
  if (
    keys.some((k) => !["kind", "supplierId", "password"].includes(k)) ||
    (kind !== "reveal" && kind !== "change") ||
    !UUID_RE.test(supplierId) ||
    !password
  ) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  // Authorizes the caller (session/JWT, entitlement, budget.manageSuppliers,
  // supplier in the caller's own workspace) BEFORE any password is checked.
  const check = await dispatch("stepup_check", { kind, supplierId });
  if (check.error) {
    sendRpcError(res, check.error);
    return;
  }
  const checked = (check.data ?? {}) as { action?: unknown; actorId?: unknown };
  const action = typeof checked.action === "string" ? checked.action : "";
  const actorId = typeof checked.actorId === "string" ? checked.actorId : "";
  if (!action || !actorId) {
    sendError(res, 500, "SERVER_ERROR");
    return;
  }

  const recordFailure = (reason: "invalid_password" | "rate_limited") =>
    dispatch("record_stepup_failure", { kind, supplierId, reason });

  const ip = clientIp(req);
  const limit = await registerAttempts(
    supabase,
    `${buckets.prefix}:actor:${buckets.actorKey(actorId)}`,
    ip ? `${buckets.prefix}:ip:${ip}` : null,
  );
  if (limit === "error") {
    sendError(res, 500, "SERVER_ERROR");
    return;
  }
  if (limit === "limited") {
    await recordFailure("rate_limited");
    sendError(res, 429, "RATE_LIMITED");
    return;
  }

  // Raw proof generated here; only its sha256 is ever stored.
  const rawProof = randomBytes(32).toString("hex");
  const outcome = await mint(password, kind, supplierId, sha256Hex(rawProof), action);
  if (outcome === "invalid_password") {
    await recordFailure("invalid_password");
    sendError(res, 401, "UNAUTHORIZED");
    return;
  }
  if (outcome !== "ok") {
    sendRpcError(res, outcome);
    return;
  }
  // Returned ONCE, here only - never logged or persisted.
  res.status(200).json({ proof: rawProof });
}

export default async function handler(req: MinimalRequest, res: MinimalResponse): Promise<void> {
  if ((req.method ?? "GET") !== "POST") {
    sendError(res, 405, "METHOD_NOT_ALLOWED");
    return;
  }

  const origin = headerValue(req.headers.origin);
  if (!origin || !allowedOrigins().has(origin)) {
    sendError(res, 403, "FORBIDDEN_ORIGIN");
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => !ALLOWED_BODY_KEYS.has(k))) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }
  const op = typeof body.op === "string" ? body.op : "";
  const rawArgs = body.args ?? {};
  if (!OP_RE.test(op) || typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }
  if (INTERNAL_OPS.has(op)) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }
  const args: Record<string, unknown> = { ...(rawArgs as Record<string, unknown>) };

  // A client never supplies a proof HASH - only the raw proof, hashed here.
  if ("proofHash" in args) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }
  if (PROOF_OPS.has(op)) {
    const proof = typeof args.proof === "string" ? args.proof : "";
    delete args.proof;
    if (proof) args.proofHash = sha256Hex(proof);
  } else if ("proof" in args) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  const owner = isOwnerPrincipal(req.url);
  let supabase: ServiceClient;

  if (owner) {
    const rawToken = extractBearerToken(req);
    if (!rawToken) {
      sendError(res, 401, "UNAUTHORIZED");
      return;
    }
    try {
      supabase = getServiceClient();
    } catch {
      sendError(res, 500, "SERVER_CONFIG_MISSING");
      return;
    }
    const verified = await verifyOwnerJwt(rawToken);
    if (!verified) {
      sendError(res, 401, "UNAUTHORIZED");
      return;
    }
    const dispatch: Dispatch = async (dop, dargs) => {
      const { data, error } = await supabase.rpc("budget_dispatch_owner", {
        p_auth_user_id: verified.authUserId,
        p_op: dop,
        p_args: dargs,
      });
      return { data, error: error as RpcError | null };
    };

    if (op === "probe") {
      await handleProbe(res, dispatch);
      return;
    }
    if (op === "stepup") {
      await handleStepUp(
        req,
        res,
        args,
        dispatch,
        async (password, _kind, _supplierId, proofHash, action) => {
          let anonClient: ReturnType<typeof getAnonAuthClient>;
          try {
            anonClient = getAnonAuthClient();
          } catch {
            return { message: "SERVER_CONFIG_MISSING" };
          }
          // Supabase Auth itself verifies the Owner's password; the email comes
          // only from the JWT-verified user, and the re-authenticated user must
          // be that same identity.
          const { data: signIn, error: signInError } = await anonClient.auth.signInWithPassword({
            email: verified.email,
            password,
          });
          // The isolated client never persists a session; drop the one this
          // re-check created.
          void anonClient.auth.signOut().catch(() => undefined);
          if (signInError || !signIn?.user || signIn.user.id !== verified.authUserId) {
            return "invalid_password";
          }
          const { error } = await supabase.rpc("election_day_owner_reauth", {
            p_auth_user_id: verified.authUserId,
            p_action: action,
            p_proof_hash: toPgBytea(proofHash),
          });
          return error ? (error as RpcError) : "ok";
        },
        { prefix: "owner-reauth", actorKey: () => verified.authUserId },
        supabase,
      );
      return;
    }

    const { data, error } = await dispatch(op, args);
    if (error) {
      sendRpcError(res, error);
      return;
    }
    res.status(200).json({ data });
    return;
  }

  // PermissionUser (worker) principal.
  const rawSessionToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (!rawSessionToken) {
    sendError(res, 401, "UNAUTHORIZED");
    return;
  }
  try {
    supabase = getServiceClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }
  const sessionHash = toPgBytea(sha256Hex(rawSessionToken));
  const dispatch: Dispatch = async (dop, dargs) => {
    const { data, error } = await supabase.rpc("budget_dispatch_worker", {
      p_session_hash: sessionHash,
      p_op: dop,
      p_args: dargs,
    });
    return { data, error: error as RpcError | null };
  };

  if (op === "probe") {
    await handleProbe(res, dispatch);
    return;
  }
  if (op === "stepup") {
    await handleStepUp(
      req,
      res,
      args,
      dispatch,
      async (password, kind, supplierId, proofHash) => {
        const { error } = await supabase.rpc("budget_stepup_mint_worker", {
          p_session_hash: sessionHash,
          p_password: password,
          p_kind: kind,
          p_supplier_id: supplierId,
          p_proof_hash: toPgBytea(proofHash),
        });
        if (!error) return "ok";
        // The session was already authorized by stepup_check, so an
        // UNAUTHORIZED here is the password check itself.
        return (error as RpcError).message === "UNAUTHORIZED" ? "invalid_password" : (error as RpcError);
      },
      { prefix: "reauth", actorKey: (actorId) => actorId },
      supabase,
    );
    return;
  }

  const { data, error } = await dispatch(op, args);
  if (error) {
    sendRpcError(res, error);
    return;
  }
  res.status(200).json({ data });
}
