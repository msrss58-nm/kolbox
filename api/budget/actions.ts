import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  extractBearerToken,
  getAnonAuthClient,
  getServiceClient,
  verifyOwnerJwt,
} from "../election-day/_ownerAuth.js";
import { renderOrderFormPdf, type OrderFormSnapshot } from "./_orderFormPdf.js";

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
//
// Budget Stage 4 adds the DOCUMENT ops, also handled here because they touch
// Storage (private bucket "budget-documents") - every one is authorized by the
// dispatcher FIRST, and the Storage path always comes from the database:
//   document_upload_start    -> DB records the intent (server-generated path)
//                               -> a signed direct-to-Storage upload URL
//   document_upload_complete -> the stored bytes are downloaded and VERIFIED
//                               (size, magic bytes vs the declared type,
//                               sha256) -> finalize, or delete + reject
//   document_download        -> a 60-second signed link (attachment)
//   order_form_preview       -> server-side PDF, returned, never stored
//   order_form_generate      -> server-side PDF -> Storage -> recorded as the
//                               next version (a failed record deletes the object)
// The DB ops these use internally (lookup/finalize/reject/locate/data/record)
// are refused from a client, exactly like the step-up internals.
//
// Budget Stage 7A adds:
//   export_document -> one stored document of the Owner's DELETION EXPORT, as a
//                      60-second signed link (the DB authorizes, logs the
//                      issuance and records it as served by that export)
//   GET + Authorization: Bearer <CRON_SECRET> (the Vercel Cron convention)
//                   -> the Storage orphan cleanup: the DB lists the objects
//                      nothing can reference any more (budget_storage_orphans),
//                      this removes them through the Storage API in one bounded
//                      batch and records the run. Without CRON_SECRET the GET
//                      stays closed (405), as before.

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
const INTERNAL_OPS = new Set<string>([
  "stepup_check",
  "record_stepup_failure",
  "document_upload_lookup",
  "document_upload_finalize",
  "document_upload_reject",
  "document_version_locate",
  "order_form_data",
  "order_form_record",
  "export_document_locate",
]);
/** Stage 4 ops that touch Storage / render a PDF, handled in this file
 * (+ Stage 7A: one document of a deletion export). */
const DOCUMENT_OPS = new Set<string>([
  "document_upload_start",
  "document_upload_complete",
  "document_download",
  "order_form_preview",
  "order_form_generate",
  "export_document",
]);
/** Stage 7A Storage orphan cleanup: at most this many objects per run. */
const CLEANUP_BATCH = 200;
const DOCUMENTS_BUCKET = "budget-documents";
const SIGNED_LINK_SECONDS = 60;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const HEIC_BRANDS = new Set<string>(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);
const HEIF_BRANDS = new Set<string>(["mif1", "msf1", "heif"]);

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
  // Stage 4 - documents / order form.
  UNSUPPORTED_FILE_TYPE: 400,
  FILE_TOO_LARGE: 400,
  TOO_MANY_PENDING_UPLOADS: 429,
  UPLOAD_EXPIRED: 409,
  DOCUMENT_ARCHIVED: 409,
  DOCUMENT_TYPE_MANAGED: 409,
  DOCUMENT_TYPE_SYSTEM: 409,
  ORDER_FORM_NOT_APPLICABLE: 409,
  ORDER_FORM_SUPERSEDED: 409,
  // Stage 5 - party funding workflow.
  SUBMISSION_BLOCKED: 409,
  SUBMISSION_NOT_READY: 409,
  PARTY_EXCEEDS_PREAPPROVAL: 409,
  // Stage 7A - deletion export.
  EXPORT_STALE: 409,
  EXPORT_INCOMPLETE: 409,
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

function sha256Hex(raw: string | Uint8Array): string {
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
    if ((message === "CLOSE_BLOCKED" || message === "SUBMISSION_BLOCKED") && /^[A-Z_,]+$/.test(detail)) {
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

/** The file's REAL type from its first bytes (never from the name or the
 * client's Content-Type). null = not one of the accepted types. */
function sniffMime(b: Uint8Array): string | null {
  const ascii = (from: number, len: number) => String.fromCharCode(...b.subarray(from, from + len));
  if (b.length >= 5 && ascii(0, 5) === "%PDF-") return "application/pdf";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return "image/png";
  if (b.length >= 12 && ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4);
    if (HEIC_BRANDS.has(brand)) return "image/heic";
    if (HEIF_BRANDS.has(brand)) return "image/heif";
  }
  return null;
}

/** HEIC and HEIF are the same container family; a phone labels them loosely. */
function sameFileType(detected: string, declared: string): boolean {
  const family = (m: string) => (m === "image/heic" || m === "image/heif" ? "heif" : m);
  return family(detected) === family(declared);
}

function onlyKeys(args: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(args).every((k) => keys.includes(k));
}

/** Stage 4 document ops (see the header comment). Every Storage action runs
 * only after the dispatcher authorized the caller for that exact object. */
async function handleDocumentOp(
  res: MinimalResponse,
  op: string,
  args: Record<string, unknown>,
  dispatch: Dispatch,
  supabase: ServiceClient,
): Promise<void> {
  const storage = supabase.storage.from(DOCUMENTS_BUCKET);

  if (op === "document_upload_start") {
    const { data, error } = await dispatch("document_upload_start", args);
    if (error) {
      sendRpcError(res, error);
      return;
    }
    const d = (data ?? {}) as { uploadId?: unknown; storagePath?: unknown; expiresAt?: unknown; maxBytes?: unknown };
    if (typeof d.uploadId !== "string" || typeof d.storagePath !== "string") {
      sendError(res, 500, "SERVER_ERROR");
      return;
    }
    // Bound to this one server-generated path; never overwrites (upsert off).
    const signed = await storage.createSignedUploadUrl(d.storagePath);
    if (signed.error || !signed.data?.signedUrl) {
      sendError(res, 502, "STORAGE_ERROR");
      return;
    }
    res.status(200).json({ data: { uploadId: d.uploadId, uploadUrl: signed.data.signedUrl, expiresAt: d.expiresAt, maxBytes: d.maxBytes } });
    return;
  }

  if (op === "document_upload_complete") {
    const uploadId = typeof args.uploadId === "string" ? args.uploadId : "";
    if (!onlyKeys(args, ["uploadId"]) || !UUID_RE.test(uploadId)) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    const look = await dispatch("document_upload_lookup", { uploadId });
    if (look.error) {
      sendRpcError(res, look.error);
      return;
    }
    const u = (look.data ?? {}) as { storagePath?: string; mimeType?: string; sizeBytes?: number; state?: string; expired?: boolean };
    if (typeof u.storagePath !== "string" || typeof u.mimeType !== "string" || typeof u.sizeBytes !== "number") {
      sendError(res, 500, "SERVER_ERROR");
      return;
    }
    if (u.state === "completed") {
      // A replay (the first response was lost): the DB answers the same result.
      const again = await dispatch("document_upload_finalize", {
        uploadId, sha256: "0".repeat(64), sizeBytes: u.sizeBytes, mimeType: u.mimeType,
      });
      if (again.error) {
        sendRpcError(res, again.error);
        return;
      }
      res.status(200).json({ data: again.data });
      return;
    }
    if (u.state !== "pending") {
      sendError(res, 409, "INVALID_TRANSITION");
      return;
    }
    const path = u.storagePath;
    const reject = async (reason: string, status: number, code: string) => {
      await storage.remove([path]).catch(() => undefined);
      await dispatch("document_upload_reject", { uploadId, reason });
      sendError(res, status, code);
    };
    if (u.expired) {
      await reject("expired", 409, "UPLOAD_EXPIRED");
      return;
    }
    const dl = await storage.download(path);
    if (dl.error || !dl.data) {
      // Nothing stored yet: the intent stays open until it expires.
      sendError(res, 409, "UPLOAD_MISSING");
      return;
    }
    const bytes = new Uint8Array(await dl.data.arrayBuffer());
    if (bytes.length > MAX_FILE_BYTES) {
      await reject("too_large", 400, "FILE_TOO_LARGE");
      return;
    }
    if (bytes.length !== u.sizeBytes) {
      await reject("size_mismatch", 400, "INVALID_FILE");
      return;
    }
    // The real type from the bytes AND the Content-Type Storage recorded (the
    // one it will serve) must both match what was declared at start.
    const detected = sniffMime(bytes);
    const storedType = (dl.data.type || "").split(";")[0].trim().toLowerCase();
    if (!detected || !sameFileType(detected, u.mimeType) || !storedType || !sameFileType(storedType, u.mimeType)) {
      await reject("type_mismatch", 400, "INVALID_FILE");
      return;
    }
    const fin = await dispatch("document_upload_finalize", {
      uploadId, sha256: sha256Hex(bytes), sizeBytes: bytes.length, mimeType: u.mimeType,
    });
    if (fin.error) {
      sendRpcError(res, fin.error);
      return;
    }
    res.status(200).json({ data: fin.data });
    return;
  }

  if (op === "document_download") {
    const versionId = typeof args.versionId === "string" ? args.versionId : "";
    if (!onlyKeys(args, ["versionId"]) || !UUID_RE.test(versionId)) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    const loc = await dispatch("document_version_locate", { versionId });
    if (loc.error) {
      sendRpcError(res, loc.error);
      return;
    }
    const l = (loc.data ?? {}) as { storagePath?: string; fileName?: string; mimeType?: string };
    if (typeof l.storagePath !== "string" || typeof l.fileName !== "string") {
      sendError(res, 500, "SERVER_ERROR");
      return;
    }
    const signed = await storage.createSignedUrl(l.storagePath, SIGNED_LINK_SECONDS, { download: l.fileName });
    if (signed.error || !signed.data?.signedUrl) {
      sendError(res, 502, "STORAGE_ERROR");
      return;
    }
    res.status(200).json({ data: { url: signed.data.signedUrl, expiresIn: SIGNED_LINK_SECONDS, fileName: l.fileName, mimeType: l.mimeType } });
    return;
  }

  if (op === "export_document") {
    const exportId = typeof args.exportId === "string" ? args.exportId : "";
    const versionId = typeof args.versionId === "string" ? args.versionId : "";
    if (!onlyKeys(args, ["exportId", "versionId"]) || !UUID_RE.test(exportId) || !UUID_RE.test(versionId)) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    const loc = await dispatch("export_document_locate", { exportId, versionId });
    if (loc.error) {
      sendRpcError(res, loc.error);
      return;
    }
    const l = (loc.data ?? {}) as { storagePath?: string; fileName?: string; mimeType?: string; sha256?: string; sizeBytes?: number };
    if (typeof l.storagePath !== "string" || typeof l.fileName !== "string") {
      sendError(res, 500, "SERVER_ERROR");
      return;
    }
    const signed = await storage.createSignedUrl(l.storagePath, SIGNED_LINK_SECONDS);
    if (signed.error || !signed.data?.signedUrl) {
      sendError(res, 502, "STORAGE_ERROR");
      return;
    }
    res.status(200).json({ data: {
      url: signed.data.signedUrl, expiresIn: SIGNED_LINK_SECONDS, fileName: l.fileName, mimeType: l.mimeType,
      sha256: l.sha256, sizeBytes: l.sizeBytes,
    } });
    return;
  }

  // Order form: preview (returned, never stored) or generate (stored as the
  // next version). The client names only the expense.
  const expenseId = typeof args.expenseId === "string" ? args.expenseId : "";
  if (!onlyKeys(args, ["expenseId"]) || !UUID_RE.test(expenseId)) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }
  const final = op === "order_form_generate";
  const prep = await dispatch("order_form_data", { expenseId, final });
  if (prep.error) {
    sendRpcError(res, prep.error);
    return;
  }
  const p = (prep.data ?? {}) as {
    snapshot?: OrderFormSnapshot; expenseVersion?: number; versionNo?: number; storagePath?: string | null; fileName?: string;
  };
  if (!p.snapshot || typeof p.versionNo !== "number" || typeof p.fileName !== "string") {
    sendError(res, 500, "SERVER_ERROR");
    return;
  }
  let pdf: Uint8Array;
  try {
    pdf = await renderOrderFormPdf(p.snapshot, { preview: !final, versionNo: final ? p.versionNo : null });
  } catch {
    sendError(res, 500, "SERVER_ERROR");
    return;
  }
  if (!final) {
    res.status(200).json({ data: { pdfBase64: Buffer.from(pdf).toString("base64"), fileName: p.fileName } });
    return;
  }
  if (typeof p.storagePath !== "string" || pdf.length > MAX_FILE_BYTES) {
    sendError(res, 500, "SERVER_ERROR");
    return;
  }
  const up = await storage.upload(p.storagePath, pdf, { contentType: "application/pdf", upsert: false });
  if (up.error) {
    sendError(res, 502, "STORAGE_ERROR");
    return;
  }
  const rec = await dispatch("order_form_record", {
    expenseId, expenseVersion: p.expenseVersion, versionNo: p.versionNo, storagePath: p.storagePath,
    sha256: sha256Hex(pdf), sizeBytes: pdf.length, fileName: p.fileName, snapshot: p.snapshot,
  });
  if (rec.error) {
    // Nothing references the object: remove it, so no orphan PDF remains.
    await storage.remove([p.storagePath]).catch(() => undefined);
    sendRpcError(res, rec.error);
    return;
  }
  res.status(200).json({ data: rec.data });
}

/** The scheduler's credential: exactly `Bearer <CRON_SECRET>` (constant-time
 * compare). No secret configured (or a short one) = never authorized. */
function cronAuthorized(req: MinimalRequest): boolean {
  const secret = process.env.CRON_SECRET ?? "";
  if (secret.length < 16) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(headerValue(req.headers.authorization) ?? "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Stage 7A Storage orphan cleanup (see the header comment). The DB decides
 * what is an orphan; nothing referenced by a document version or protected by
 * a live upload intent is ever listed. */
async function handleStorageCleanup(res: MinimalResponse): Promise<void> {
  let supabase: ServiceClient;
  try {
    supabase = getServiceClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }
  const found = await supabase.rpc("budget_storage_orphans", { p_limit: CLEANUP_BATCH });
  if (found.error) {
    sendError(res, 500, "SERVER_ERROR");
    return;
  }
  const names = ((found.data ?? []) as { object_name?: unknown }[])
    .map((r) => r.object_name)
    .filter((n): n is string => typeof n === "string");
  let removed: string[] = [];
  if (names.length > 0) {
    const del = await supabase.storage.from(DOCUMENTS_BUCKET).remove(names);
    if (!del.error) {
      const listed = new Set(names);
      removed = (del.data ?? []).map((o) => o.name).filter((n): n is string => typeof n === "string" && listed.has(n));
    }
  }
  const failed = names.length - removed.length;
  const rec = await supabase.rpc("budget_storage_cleanup_record", {
    p_candidates: names.length, p_removed: removed, p_failed: failed,
  });
  if (rec.error) {
    sendError(res, 500, "SERVER_ERROR");
    return;
  }
  res.status(200).json({ data: { candidates: names.length, removed: removed.length, failed } });
}

export default async function handler(req: MinimalRequest, res: MinimalResponse): Promise<void> {
  if ((req.method ?? "GET") === "GET" && cronAuthorized(req)) {
    await handleStorageCleanup(res);
    return;
  }
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
          // The isolated client never persists a session; revoke the ONE session
          // this re-check created. scope "local" is essential: supabase-js
          // defaults to "global", which would revoke every session of the
          // Owner - including the one making this request (Stage 4 regression
          // finding: the Owner was signed out after the first step-up).
          await anonClient.auth.signOut({ scope: "local" }).catch(() => undefined);
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
    if (DOCUMENT_OPS.has(op)) {
      await handleDocumentOp(res, op, args, dispatch, supabase);
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
  if (DOCUMENT_OPS.has(op)) {
    await handleDocumentOp(res, op, args, dispatch, supabase);
    return;
  }

  const { data, error } = await dispatch(op, args);
  if (error) {
    sendRpcError(res, error);
    return;
  }
  res.status(200).json({ data });
}
