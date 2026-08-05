/** Shared fixtures for the Dynamic Roles & Permissions Phase 1 Node smoke
 * tests. `BUILT_IN_ROLE_SEED` is re-exported (not re-typed) from the shipped
 * app code so tests exercise the exact same data the real `MockApi` returns
 * - see `scripts/smoke-role-seed-parity.ts` for the check that this array
 * (via the shipped module) never drifts from the Phase 0 migration's SQL
 * seed. `MALFORMED_ROLE_ROWS` are hand-built untrusted rows for exercising
 * `normalizeRoleRecord`'s fail-closed validation. */
export { BUILT_IN_ROLE_SEED } from "../../src/permissions/builtInRoleSeed";
import type { RawRoleRow } from "../../src/permissions/roleRecordMapper";

export const MALFORMED_ROLE_ROWS: Record<string, RawRoleRow> = {
  unknownScopeType: {
    id: "malformed-1",
    name: "תפקיד תקול",
    description: "",
    permissions: ["voter.markVoted"],
    scope_type: "everything", // not a real scope_type
    scope_value: null,
    legacy_role_key: "voting",
  },
  missingScopeType: {
    id: "malformed-2",
    name: "תפקיד תקול",
    description: "",
    permissions: [],
    scope_type: null,
    scope_value: null,
    legacy_role_key: null,
  },
  unknownLegacyRoleKey: {
    id: "malformed-3",
    name: "תפקיד תקול",
    description: "",
    permissions: [],
    scope_type: "all",
    scope_value: null,
    legacy_role_key: "superadmin", // not a real DatabaseRole
  },
  garbagePermissionStrings: {
    id: "malformed-4",
    name: "תפקיד תקול",
    description: "",
    // a real permission mixed with a stale/typo'd string and non-string
    // junk that a hand-edited DB row could conceivably contain
    permissions: ["voter.markVoted", "sudo.deleteEverything", 123, null, undefined],
    scope_type: "all",
    scope_value: null,
    legacy_role_key: "manager",
  },
};
