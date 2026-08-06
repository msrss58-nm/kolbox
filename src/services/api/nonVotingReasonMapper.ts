import type { NonVotingReason } from "../../types";

/** The untrusted shape of one row as it comes back from the
 * `election_day_list_non_voting_reasons()` RPC - `unknown` for every field,
 * mirroring `RawRoleRow` (`permissions/roleRecordMapper.ts`). Not
 * security-critical the way a role's `permissions`/`scope_type` are (a
 * corrupted reason row can't grant anyone a capability), but normalized the
 * same defensive way regardless - fail-safe, never a blind cast, never a
 * thrown exception on a malformed row. */
export interface RawNonVotingReasonRow {
  id: unknown;
  name: unknown;
  description: unknown;
  is_active: unknown;
  sort_order: unknown;
}

/** The one and only place a raw `election_day_list_non_voting_reasons()` row
 * becomes a trusted `NonVotingReason`.
 * - `id`/`name`/`description`: coerced to `string`, defaulting to `""` if
 *   the RPC ever returned something else.
 * - `is_active`: only a real `boolean` survives - anything else (missing,
 *   null, a stray string) normalizes to `false`, never guessed at as
 *   "probably active".
 * - `sort_order`: only a finite `number` survives - anything else falls
 *   back to `Number.MAX_SAFE_INTEGER` so a corrupted row sinks to the end
 *   of the display order instead of crashing a sort or jumping to the top. */
export function normalizeNonVotingReasonRecord(
  row: RawNonVotingReasonRow,
): NonVotingReason {
  return {
    id: typeof row.id === "string" ? row.id : String(row.id ?? ""),
    name: typeof row.name === "string" ? row.name : "",
    description: typeof row.description === "string" ? row.description : "",
    isActive: row.is_active === true,
    sortOrder:
      typeof row.sort_order === "number" && Number.isFinite(row.sort_order)
        ? row.sort_order
        : Number.MAX_SAFE_INTEGER,
  };
}
