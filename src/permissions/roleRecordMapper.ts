import { ALL_PERMISSIONS } from "./permissionsMap";
import type { Json, Permission, RoleRecord, RoleScopeType } from "./types";

/** The untrusted shape of one row as it comes back from the
 * `election_day_list_roles()` RPC - `unknown` for every field whose content
 * this app must not blindly trust (permissions/scope_type directly drive
 * security decisions, unlike e.g. a voter's phone number). Deliberately has
 * no import on Supabase/the API layer, so it stays Node-testable the same
 * way `computePermissions.ts` is (see `scripts/smoke-role-normalization.ts`). */
export interface RawRoleRow {
  id: unknown;
  name: unknown;
  description: unknown;
  permissions: unknown;
  scope_type: unknown;
  scope_value: unknown;
}

const VALID_SCOPE_TYPES: readonly RoleScopeType[] = ["all", "assigned_to_me"];
const ALL_PERMISSIONS_SET: ReadonlySet<string> = new Set(ALL_PERMISSIONS);

function isValidScopeType(value: unknown): value is RoleScopeType {
  return (
    typeof value === "string" && (VALID_SCOPE_TYPES as readonly string[]).includes(value)
  );
}

/**
 * The one and only place a raw `election_day_list_roles()` row is turned
 * into a trusted `RoleRecord` - never a blind cast. Every untrusted field is
 * validated independently and fails closed on its own, so one row with e.g.
 * a stray `scope_type` typo still yields a usable record for everything
 * else, but with `scopeType: null` (which `resolveVisibleContacts` then
 * treats as "show nothing", never "show everything"):
 *
 * - `permissions`: only strings that are literally in `ALL_PERMISSIONS`
 *   survive - an unrecognized/stale/typo'd string is dropped, never cast
 *   through. A corrupted or stale DB row can therefore only ever
 *   under-grant relative to what this build of the frontend knows how to
 *   check, never over-grant.
 * - `scope_type`: `"all"` / `"assigned_to_me"` pass through; anything else
 *   (including missing/null/a future not-yet-supported value) becomes
 *   `null` - never guessed at or defaulted to a permissive value.
 * - `scope_value`: passed through as-is as `Json | null` - Phase 1 never
 *   reads it, so there is nothing to validate yet.
 * - `id`/`name`/`description`: coerced to `string`, defaulting to `""` if
 *   the RPC ever returned something else (should not happen given the
 *   migration's column types, but this mapper never assumes that).
 */
export function normalizeRoleRecord(row: RawRoleRow): RoleRecord {
  const rawPermissions = Array.isArray(row.permissions) ? row.permissions : [];
  const permissions: Permission[] = rawPermissions.filter(
    (p): p is Permission => typeof p === "string" && ALL_PERMISSIONS_SET.has(p),
  );

  return {
    id: typeof row.id === "string" ? row.id : String(row.id ?? ""),
    name: typeof row.name === "string" ? row.name : "",
    description: typeof row.description === "string" ? row.description : "",
    permissions,
    scopeType: isValidScopeType(row.scope_type) ? row.scope_type : null,
    scopeValue: (row.scope_value ?? null) as Json | null,
  };
}
