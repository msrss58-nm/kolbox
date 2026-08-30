/**
 * Phase 3 Import/Clear frontend cutover: pure fetch wrappers around the
 * trusted, session-derived v3 flow (`api/election-day/reauth.ts` +
 * `api/election-day/import-voters.ts` / `clear-voters.ts`, already deployed
 * to Production - Backend EXPAND). No React/Zustand dependency, mirroring
 * `electionDayTrustedPermissionUserClient.ts`/`electionDayTrustedUsersClient.ts`'s
 * own pattern exactly.
 *
 * Neither `importVotersTrusted` nor `clearVotersTrusted` caches the reauth
 * proof passed to them - the caller (the dedicated trusted hooks) must hold
 * it only as a local variable for one continuous async flow and never write
 * it into `electionDayReauthProof.ts`'s store, which is exclusively the
 * legacy general-purpose proof cache shared by the remaining `_v2`
 * reauth-gated actions.
 */

import type { NewElectionDayVoter } from "../../services/api";

const REAUTH_ENDPOINT = "/api/election-day/reauth";
const IMPORT_VOTERS_ENDPOINT = "/api/election-day/import-voters";
const CLEAR_VOTERS_ENDPOINT = "/api/election-day/clear-voters";

export type TrustedReauthResult =
  | { status: "ok"; proof: string }
  | { status: "unauthorized" }
  | { status: "rate_limited" }
  | { status: "error" };

async function reauthForAction(
  password: string,
  action: "import_voters" | "clear_voters",
): Promise<TrustedReauthResult> {
  try {
    const res = await fetch(REAUTH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, action }),
    });
    if (res.status === 200) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { status: "error" };
      }
      const proof =
        body &&
        typeof body === "object" &&
        typeof (body as Record<string, unknown>).reauthProof === "string"
          ? ((body as Record<string, unknown>).reauthProof as string)
          : null;
      return proof ? { status: "ok", proof } : { status: "error" };
    }
    if (res.status === 401) return { status: "unauthorized" };
    if (res.status === 429) return { status: "rate_limited" };
    return { status: "error" };
  } catch {
    return { status: "error" };
  }
}

/** Mints a one-time, action-bound proof for the `import_voters` action
 * against the current HttpOnly session. */
export function reauthForImportVoters(password: string): Promise<TrustedReauthResult> {
  return reauthForAction(password, "import_voters");
}

/** Mints a one-time, action-bound proof for the `clear_voters` action
 * against the current HttpOnly session. */
export function reauthForClearVoters(password: string): Promise<TrustedReauthResult> {
  return reauthForAction(password, "clear_voters");
}

export type TrustedImportResult =
  | { status: "ok"; count: number }
  | { status: "unauthorized" }
  | { status: "forbidden" }
  | { status: "allocation_activity_started" }
  | { status: "invalid_request" }
  | { status: "error" };

/** Imports the already-parsed voter rows via the trusted server path - the
 * session cookie proves the caller, `reauthProof` proves recent one-time
 * step-up authentication for this exact action and exact call. The server
 * derives actor/workspace itself. `voters` is the same camelCase array
 * shape `electionDayImport.ts`'s `parseElectionDaySheet` has always
 * produced (`NewElectionDayVoter`) - mapped to the snake_case shape the
 * `p_voters jsonb` RPC parameter expects, exactly mirroring the legacy
 * `SupabaseElectionDayApi.importElectionDayVoters()`'s own mapping (see its
 * own `masad/first_name/last_name/street/house_number/city/phone/
 * coordinator` object literal) - only the transport changed, not the
 * parsing or the wire shape. */
export async function importVotersTrusted(
  voters: NewElectionDayVoter[],
  reauthProof: string,
): Promise<TrustedImportResult> {
  try {
    const mappedVoters = voters.map((r) => ({
      masad: r.masad,
      first_name: r.firstName,
      last_name: r.lastName,
      street: r.street,
      house_number: r.houseNumber,
      city: r.city,
      phone: r.phone,
      coordinator: r.coordinator,
    }));
    const res = await fetch(IMPORT_VOTERS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voters: mappedVoters, reauthProof }),
    });
    if (res.status === 200) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { status: "error" };
      }
      const count =
        body &&
        typeof body === "object" &&
        typeof (body as Record<string, unknown>).count === "number"
          ? ((body as Record<string, unknown>).count as number)
          : null;
      return count === null ? { status: "error" } : { status: "ok", count };
    }
    if (res.status === 401) return { status: "unauthorized" };
    if (res.status === 403) return { status: "forbidden" };
    if (res.status === 409) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { status: "error" };
      }
      const code =
        body && typeof body === "object"
          ? (body as Record<string, unknown>).error
          : undefined;
      return code === "ALLOCATION_ACTIVITY_STARTED"
        ? { status: "allocation_activity_started" }
        : { status: "error" };
    }
    if (res.status === 400) return { status: "invalid_request" };
    return { status: "error" };
  } catch {
    return { status: "error" };
  }
}

export type TrustedClearResult =
  | { status: "ok" }
  | { status: "unauthorized" }
  | { status: "forbidden" }
  | { status: "error" };

/** Clears the workspace's voter-file domain via the trusted server path -
 * the session cookie proves the caller, `reauthProof` proves recent
 * one-time step-up authentication for this exact action and exact call. */
export async function clearVotersTrusted(
  reauthProof: string,
): Promise<TrustedClearResult> {
  try {
    const res = await fetch(CLEAR_VOTERS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reauthProof }),
    });
    if (res.status === 200) return { status: "ok" };
    if (res.status === 401) return { status: "unauthorized" };
    if (res.status === 403) return { status: "forbidden" };
    return { status: "error" };
  } catch {
    return { status: "error" };
  }
}
