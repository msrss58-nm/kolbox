/**
 * Multi-Tenant Phase 2 - historical Backfill crash-recovery receipt.
 *
 * Purpose: if the human-run production runner process dies during/after Auth
 * creation or the RPC call, this receipt preserves enough NON-SECRET state
 * to run deterministic recovery/reconciliation afterward (see
 * recover-historical-backfill.ts) instead of guessing. It is evidence for a
 * human/tool to inspect - never authority to retry anything automatically.
 *
 * Stored as a single JSON file in the OS temp directory
 * (`os.tmpdir()/kolbox-backfill-<runId>.json`), written via atomic
 * write-then-rename so a crash mid-write never leaves a half-written file
 * silently readable as if it were complete.
 *
 * STRICTLY FORBIDDEN in this receipt, enforced at every write by
 * `assertNoForbiddenSecrets` (not just documented - a write with a
 * forbidden key or a JWT/service-role-key-shaped value throws instead of
 * writing): temporary password, service_role key, JWT, access/refresh/OIDC
 * token, DB password/connection string, any signing secret. The temporary
 * Owner password in particular never touches this module at all - the
 * caller (run-historical-backfill-production.ts) never passes it in.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ReceiptPhase =
  | "PREFLIGHT_CONFIRMED"
  | "AUTH_CREATED"
  | "RPC_CONFIRMED"
  | "POSTFLIGHT_VERIFIED";

const PHASE_ORDER: readonly ReceiptPhase[] = [
  "PREFLIGHT_CONFIRMED",
  "AUTH_CREATED",
  "RPC_CONFIRMED",
  "POSTFLIGHT_VERIFIED",
];

export interface BackfillReceiptPreflight {
  tableBaseline: Record<string, number>;
  settingsOk: boolean;
  migrationsInSync: boolean | null;
  rpcAcl: {
    overloadCount: number;
    securityDefiner: boolean;
    searchPathEmpty: boolean;
    owner: string;
    proacl: string;
    serviceRoleExecute: boolean;
    anonExecute: boolean;
    authenticatedExecute: boolean;
  };
}

export interface BackfillReceipt {
  runId: string;
  createdAt: string;
  updatedAt: string;
  productionProjectRef: string;
  workspaceName: string;
  electionEndAtIso: string;
  ownerName: string;
  ownerPhone: string | null;
  ownerEmail: string;
  phase: ReceiptPhase;
  preflight: BackfillReceiptPreflight;
  /** Set once phase reaches AUTH_CREATED - never earlier. */
  authUserId: string | null;
  /** Set once phase reaches RPC_CONFIRMED - never earlier. */
  rpcResult: {
    workspaceId: string;
    ownerId: string;
    rowCounts: Record<string, number>;
  } | null;
}

export function generateRunId(): string {
  return `run${Date.now()}${randomBytes(4).toString("hex")}`;
}

export function receiptPath(runId: string): string {
  if (!/^[a-zA-Z0-9_-]{6,80}$/.test(runId)) {
    throw new Error(`receiptPath: refusing an unsafe-shaped runId "${runId}"`);
  }
  return join(tmpdir(), `kolbox-backfill-${runId}.json`);
}

const FORBIDDEN_KEY_PATTERN =
  /password|secret|token|jwt|apikey|api_key|connection.?string|service_role|signing.?key|refresh_token|access_token/i;
// A bare JWT (header.payload.signature, each base64url) or a Supabase
// service-role/anon key shares this exact 3-segment base64url shape - catch
// it by VALUE too, not just by key name, so a value accidentally placed
// under an innocuous-sounding key is still caught.
const JWT_SHAPED_VALUE = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;

/** Recursively scans an object for forbidden secret-shaped keys or
 * JWT-shaped string values. Throws on the first match - never silently
 * strips/redacts, since a receipt that silently drops a field is worse than
 * one that fails loudly during development. */
export function assertNoForbiddenSecrets(value: unknown, path = "receipt"): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (JWT_SHAPED_VALUE.test(value)) {
      throw new Error(
        `assertNoForbiddenSecrets: value at ${path} looks like a JWT/API key - refusing to write to the receipt.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoForbiddenSecrets(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY_PATTERN.test(k)) {
        throw new Error(
          `assertNoForbiddenSecrets: forbidden key "${k}" at ${path} - refusing to write to the receipt.`,
        );
      }
      assertNoForbiddenSecrets(v, `${path}.${k}`);
    }
  }
}

/** Requires the receipt to be in EXACTLY `requiredFrom` before advancing to
 * the next phase in sequence - not merely "any earlier phase". Skipping a
 * phase (e.g. PREFLIGHT_CONFIRMED straight to POSTFLIGHT_VERIFIED) would
 * mark a state with no evidence behind it (no authUserId/rpcResult), which
 * is exactly what this receipt exists to prevent. */
function assertPhaseAdvance(
  receipt: BackfillReceipt,
  requiredFrom: ReceiptPhase,
  to: ReceiptPhase,
): void {
  if (receipt.phase !== requiredFrom) {
    throw new Error(
      `assertPhaseAdvance: refusing to move to ${to} - requires phase ${requiredFrom} exactly, receipt is at ${receipt.phase}. A later state must never be marked without evidence for the phase immediately before it.`,
    );
  }
}

/** Atomic write: write to a sibling `.tmp` file, then rename over the real
 * path - a crash mid-write leaves only an orphaned `.tmp` file, never a
 * half-written receipt at the real path. Best-effort restrictive
 * permissions (0o600) - a no-op on Windows filesystems that don't support
 * POSIX modes, which is fine since %TEMP% is already per-user. */
function writeReceiptAtomic(receipt: BackfillReceipt): void {
  assertNoForbiddenSecrets(receipt);
  const finalPath = receiptPath(receipt.runId);
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(receipt, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // best-effort only - not all filesystems support POSIX modes
  }
  renameSync(tmpPath, finalPath);
}

export function createReceipt(params: {
  runId: string;
  productionProjectRef: string;
  workspaceName: string;
  electionEndAtIso: string;
  ownerName: string;
  ownerPhone: string | null;
  ownerEmail: string;
  preflight: BackfillReceiptPreflight;
}): BackfillReceipt {
  const now = new Date().toISOString();
  const receipt: BackfillReceipt = {
    runId: params.runId,
    createdAt: now,
    updatedAt: now,
    productionProjectRef: params.productionProjectRef,
    workspaceName: params.workspaceName,
    electionEndAtIso: params.electionEndAtIso,
    ownerName: params.ownerName,
    ownerPhone: params.ownerPhone,
    ownerEmail: params.ownerEmail,
    phase: "PREFLIGHT_CONFIRMED",
    preflight: params.preflight,
    authUserId: null,
    rpcResult: null,
  };
  writeReceiptAtomic(receipt);
  return receipt;
}

export function markAuthCreated(
  receipt: BackfillReceipt,
  authUserId: string,
): BackfillReceipt {
  assertPhaseAdvance(receipt, "PREFLIGHT_CONFIRMED", "AUTH_CREATED");
  const next: BackfillReceipt = {
    ...receipt,
    phase: "AUTH_CREATED",
    authUserId,
    updatedAt: new Date().toISOString(),
  };
  writeReceiptAtomic(next);
  return next;
}

export function markRpcConfirmed(
  receipt: BackfillReceipt,
  rpcResult: BackfillReceipt["rpcResult"],
): BackfillReceipt {
  assertPhaseAdvance(receipt, "AUTH_CREATED", "RPC_CONFIRMED");
  const next: BackfillReceipt = {
    ...receipt,
    phase: "RPC_CONFIRMED",
    rpcResult,
    updatedAt: new Date().toISOString(),
  };
  writeReceiptAtomic(next);
  return next;
}

export function markPostflightVerified(receipt: BackfillReceipt): BackfillReceipt {
  assertPhaseAdvance(receipt, "RPC_CONFIRMED", "POSTFLIGHT_VERIFIED");
  const next: BackfillReceipt = {
    ...receipt,
    phase: "POSTFLIGHT_VERIFIED",
    updatedAt: new Date().toISOString(),
  };
  writeReceiptAtomic(next);
  return next;
}

export function readReceipt(runId: string): BackfillReceipt {
  const p = receiptPath(runId);
  if (!existsSync(p)) {
    throw new Error(
      `readReceipt: no receipt found for runId "${runId}" at ${p}. Refusing to guess - if this run genuinely never got past password confirmation, there is nothing to recover.`,
    );
  }
  const parsed = JSON.parse(readFileSync(p, "utf8")) as BackfillReceipt;
  assertNoForbiddenSecrets(parsed);
  if (!PHASE_ORDER.includes(parsed.phase)) {
    throw new Error(
      `readReceipt: receipt at ${p} has an unrecognized phase "${parsed.phase}" - refusing to act on a malformed receipt.`,
    );
  }
  return parsed;
}
