# KolBox - Current Status

> Single source of truth for "where things stand right now." Update this file whenever production, git HEAD, or an in-flight initiative's phase changes. This file did not exist before 2026-08-05 (confirmed via `git log --all -- CURRENT_STATUS.md` returning no history) - created fresh to anchor the Dynamic Roles & Permissions rollout across sessions.

---

## Production

- **URL**: `https://kolbox-gamma.vercel.app` - live since 2026-07-19. **Active and serving Dynamic Roles & Permissions Phase 1.**
- **Vercel project**: `kolbox`, scope `nahom10`, Git integration auto-deploys on push to `master`.
- Current production deployment: `dpl_BbCLGPtefzD8CzEHvdtApUhsSThQ`, `readyState: READY`, `target: production`, built from commit `b3ce9b9` ("feat: cut election day permission engine over to dynamic roles") - created ~1 minute after that commit's push, no other push in between. Aliased to `kolbox-gamma.vercel.app` / `kolbox-nahom10.vercel.app` / `kolbox-git-master-nahom10.vercel.app`.
- Verified live on 2026-08-05 (post-deploy production smoke test): HTTP 200; Election Day login screen renders; manager/operations/`נציג קלפי` all logged in successfully via temporary RPC-created test accounts (deleted immediately after); manager saw the full 1,928-contact dataset and every admin control; operations/voting saw zero admin controls and zero contacts (scoped away, as expected - their synthetic test names matched no real coordinator); 0 console/page errors. Real data confirmed unchanged after cleanup: **1,928 voters**, **5 `PermissionUser` accounts**.

## Git

- Branch: `master`
- HEAD: `b3ce9b9` ("feat: cut election day permission engine over to dynamic roles")
- `origin/master...master`: 0 ahead / 0 behind - fully synced (push completed 2026-08-05)
- Working tree: has uncommitted documentation-only changes as of this note (this file + `CHANGELOG.md`'s post-deploy fill-in) - no application code, migration, or test changes pending.

Recent history (newest first):

```
b3ce9b9 feat: cut election day permission engine over to dynamic roles
d830d50 feat: add dynamic roles database foundation
6080d05 feat: rename voting role UI label to נציג קלפי
94ea634 docs: close election day voting-role milestone (Stage 4)
b739f4b feat: make voting a real, loggable-in election day role
```

## Election Day Permission Engine - status

The `manager` / `operations` / `voting` permission engine (`src/permissions/`) is live in production, connected to every Election Day UI surface and to the `useElectionDay.ts` mutation layer (`guardedAction`). `voting` is a real, loggable-in DB role (Stage 4, commit `b739f4b`), UI-labeled "נציג קלפי" (commit `6080d05`). This milestone is closed - see `task-plan.md`'s Progress Log for the full history. It is documented there; the initiative below is not yet.

## Dynamic Roles & Permissions - status

A separate, newer initiative: replacing the hardcoded 3-role permission engine with a DB-backed, fully editable role catalog (create/rename/delete/clone roles, assign arbitrary permission sets), while keeping today's `manager`/`operations`/`voting` behavior byte-for-byte unchanged until each phase is proven. Phases 0 and 1 are shipped and documented in `CHANGELOG.md`; Phase 2's migration is applied and live-verified against the real database but not yet committed/pushed/deployed (not yet in `CHANGELOG.md` - that entry is written once something has actually shipped, per this project's documentation convention). **None of this is yet written up in `task-plan.md`**'s Progress Log - this file remains the most current/detailed source of truth for this initiative regardless.

### Phase 0 - COMPLETE (shipped, in production)

Migration: `supabase/migrations/20260805181806_election_day_dynamic_roles_phase0.sql`
Commit: `d830d50` ("feat: add dynamic roles database foundation")
Confirmed applied both local and remote (`supabase migration list --linked` shows `20260805181806` on both sides).

Purely additive schema foundation - **zero behavior change**, verified:

1. New table `public.election_day_roles` (RLS-enabled, zero policies - same lockdown pattern as `election_day_permission_users`, access only via future SECURITY DEFINER RPCs): `id`, `name`, `description`, `permissions text[]`, `scope_type` (`'all' | 'assigned_to_me'`, default `'assigned_to_me'`), `scope_value jsonb` (reserved, unused), `legacy_role_key` (`'user' | 'manager' | 'voting'`, nullable, unique-when-not-null).
2. `election_day_permission_users.role` made nullable (a future dynamic-role user has no legacy text equivalent).
3. Seeded exactly the 3 existing roles (מנהל / משתמש / נציג קלפי) with permission sets copied verbatim from `PERMISSIONS_BY_ROLE` and scope copied from today's `scopedContacts` logic.
4. `election_day_permission_users.role_id` added, backfilled via `legacy_role_key` (never by name, never by hardcoded id), verified 100% backfilled, then set `NOT NULL`. `references election_day_roles(id) on delete restrict` - the DB-level backstop for "a role with assigned users cannot be deleted."
5. `election_day_create_permission_user` updated to also resolve+write `role_id` on every new row (frontend call shape unchanged - still `p_name`/`p_password`/`p_role`).

Also in this commit: `electionDay.manageRolesAndPermissions` added to the TS `Permission` catalog (`src/permissions/types.ts`) and granted to `manager` (`src/permissions/permissionsMap.ts`) - inert today, not yet checked by any call site. `scripts/smoke-permissions.ts` extended with assertions for the new catalog entry.

### Phase 1 - COMPLETE (shipped, in production)

Commit: `b3ce9b9` ("feat: cut election day permission engine over to dynamic roles")
Pushed to `origin/master`: complete (`0 ahead / 0 behind`).
Production deployment: `dpl_BbCLGPtefzD8CzEHvdtApUhsSThQ`, `READY`, serving `https://kolbox-gamma.vercel.app`.

Permission-engine **read-path** cutover: the permission engine now resolves a session's role by loading the live `election_day_roles` catalog instead of a hardcoded map, **fail-closed at every stage** (loading/error/an unmatched role/an unrecognized scope all deny access and show zero contacts - see "Fail-closed contract" below - this is live and active in production now, not just tested locally). No UI change; no change to how a `PermissionUser` is created (still the legacy 3-checkbox RPC/`election_day_create_permission_user`); no change to the login/session model; no change to any other main-app role; no change to `legacy_role_key` or Phase 0's seed values.

**Migration - APPLIED** (2026-08-05, to both local and the linked remote project via `supabase db push`; confirmed via `supabase migration list --linked` showing `20260805190000` on both sides):
`supabase/migrations/20260805190000_election_day_list_roles_rpc.sql` - adds `public.election_day_list_roles()`: read-only, `STABLE`, `SECURITY DEFINER`, `set search_path = ''`, schema-qualified references, `revoke all ... from public` + `grant execute ... to anon, authenticated` (same pattern as every other Election Day roster RPC), wrapped in `begin;`/`commit;`. Its own comment documents that anon access is the same already-accepted "no caller-identity check" limitation as `election_day_list_permission_users()` - not a new gap, not a login-model change.

**Live-verified against the real database** (read-only introspection + a real anon-key RPC call, 2026-08-05): `security_definer: true`; `proconfig: ["search_path=\"\""]`; returns exactly `TABLE(id uuid, name text, description text, permissions text[], scope_type text, scope_value jsonb, legacy_role_key text)` - no more, no less; `EXECUTE` granted to `anon`/`authenticated`/`service_role`/`postgres`, identical to `election_day_list_permission_users()`'s existing grant set. A live call returned exactly 3 rows whose `permissions`/`scope_type`/`legacy_role_key` match `BUILT_IN_ROLE_SEED` exactly (`scripts/smoke-role-live-db-parity.ts`, kept as a standing verification script).

**Code shipped** (commit `b3ce9b9`, 35 files changed, 1,676 insertions / 297 deletions):
- `src/permissions/`: `types.ts` (removed `EffectiveRole`; added `RoleRecord`/`RoleScopeType`/`Json`), new `roleRecordMapper.ts` (validates every untrusted RPC field - never a blind cast), new `roleCatalogController.ts` (pure `idle→loading→loaded/error` state machine, in-flight guard, explicit `retry()`, no auto-retry loop) + `roleCatalogStore.ts` (zustand wrapper), `resolveSessionRole.ts` (replaces `resolveEffectiveRole.ts`), `hasPermission.ts`/`computePermissions.ts` (now take the live catalog + its status, fail-closed), `permissionsMap.ts` (kept `ALL_PERMISSIONS`, dropped the hardcoded `PERMISSIONS_BY_ROLE`), `usePermissions.ts` (sources session + catalog), `permissionAudit.ts` (updated event type), new `builtInRoleSeed.ts` (the 3 built-in roles mirrored verbatim from the Phase 0 seed).
- `src/features/election-day/`: new `electionDayScope.ts` (`resolveVisibleContacts` - the fail-closed `scopedContacts` logic, pure/testable), `useElectionDay.ts` (wired to it), `electionDaySession.ts` (login also kicks off the role-catalog fetch).
- `src/services/api/`: `types.ts`/`supabaseElectionDayApi.ts`/`mockApi.ts`/`index.ts` - added `listElectionDayRoles()` to `ApiClient` and every implementation.
- `src/services/supabase/database.types.ts` - added the `election_day_roles` table and `election_day_list_roles` function's hand-written types (Phase 0 had left this file out of sync; fixed as part of getting `tsc -b` clean for this phase).
- `scripts/`: rewrote `smoke-permissions.ts`/`smoke-permission-logic.ts`/`smoke-permission-ui.ts`/`smoke-bootstrap.ts`/`harness/mockUsePermissions.ts` against the new engine; added `smoke-role-normalization.ts`, `smoke-role-catalog.ts`, `smoke-election-day-scope.ts`, `smoke-role-seed-parity.ts`, and `fixtures/electionDayRoles.ts`.

**Fail-closed contract** (the security requirement this phase was corrected to satisfy - see the in-session review that flagged and fixed an earlier fail-open draft):
- Catalog status `"idle"` / `"loading"` / `"error"` → `can()` false for every permission, `scopedContacts` → `[]`.
- Session's role text has no matching catalog row → same: deny-all / `[]`.
- A resolved role's `scopeType` is missing/unrecognized → `scopedContacts` → `[]`.
- Only `scopeType === "all"` shows every contact; only `scopeType === "assigned_to_me"` shows the caller's own-coordinator contacts.
- No path anywhere falls back to a manager-equivalent or "show everything" state as a result of `null`/loading/error.
- The one unchanged, pre-existing exception: **no Election Day session at all** (the roster-empty bootstrap window) still sees everything unfiltered - that is `ElectionDayGuard`'s existing, approved bootstrap design, untouched by this phase, not part of the fail-open bug that was fixed.

**Verified locally**: `tsc -b` clean, `eslint .` clean (0 errors), `npm run build` clean, and all 9 relevant smoke suites pass - `smoke-permissions`, `smoke-permission-logic`, `smoke-permission-ui`, `smoke-bootstrap` (rewritten against the new engine, same truth table as before), `smoke-role-normalization` (validation-boundary fail-closed cases), `smoke-role-catalog` (state-machine transitions, in-flight guard, retry-after-error), `smoke-election-day-scope` (the fail-closed `scopedContacts` contract itself), `smoke-role-seed-parity` (the TS fixture is byte-for-byte identical to the Phase 0 migration's actual SQL seed), `smoke-role-live-db-parity` (the live, applied DB matches the same fixture). A grep sweep confirmed no new hardcoded `role === "..."` comparisons were introduced in Election Day code, and no remaining code import of the removed `EffectiveRole` type or `PERMISSIONS_BY_ROLE` map.

**Live login-verified, pre-deploy** (local dev server against the real migrated database, 3 temporary `PermissionUser` accounts created via RPC and deleted immediately after): manager (`scopeType: "all"`) saw the full contact list and every admin control; operations and voting (`scopeType: "assigned_to_me"`) saw zero admin controls, a restricted main-nav, and zero contacts (their synthetic test names matched no real coordinator - a data-independent limitation, not a scoping failure; the actual "sees only its own matching contacts" behavior is what `smoke-election-day-scope.ts`'s pure-logic suite proves against synthetic matching/non-matching data). 23/23 checks passed, 0 console/page errors.

**Production smoke test - PASSED** (2026-08-05, post-deploy, `https://kolbox-gamma.vercel.app`, 3 new temporary `PermissionUser` accounts created via RPC and deleted immediately after): HTTP 200; Election Day login screen renders; manager/operations/`נציג קלפי` all logged in successfully; manager saw the full 1,928-contact dataset (`סה"כ בוחרים 1928`, real per-coordinator breakdown) and every admin control; operations/voting saw zero admin controls, a restricted main-nav, and zero contacts (same data-independent limitation as pre-deploy); 0 console/page errors. Real data confirmed unchanged after cleanup: **1,928 voters** (unchanged), **5 `PermissionUser` accounts** (unchanged - see "Production data baseline" below).

**Production data baseline** (checked 2026-08-05, read-only, reconfirmed unchanged after this phase's full pre- and post-deploy verification): the `election_day_permission_users` roster has **5** rows, not the 4 previously documented - `נחום משה` (manager), `אבי`/`אלי`/`יעקוב` (user), and one additional account named **"66"** (role `user`, `created_at` 2026-08-05 18:41:28 UTC). This account's origin is **unknown** - it does not appear as a `coordinator` value on any real voter, ride-status event, or ride-coordinator row, so no corroborating signal either way was found from existing data. Not created by this initiative's own scripts; left completely untouched throughout (not modified, not deleted, not reset).

**Phase 1 is fully closed**: code implemented, migration applied, committed, pushed, deployed, and live-verified in production with zero regressions.

### Phase 2 - MIGRATION APPLIED, LIVE-VERIFIED (not yet committed/pushed/deployed)

Real role management: a "תפקידים" UI tab (`RoleManagementModal.tsx` + `useRoleManagement.ts`), RPCs to create/update/delete/clone a role, and a new RPC to create a `PermissionUser` against an arbitrary `role_id` (not just the 3 legacy checkboxes, via `PermissionUsersModal.tsx`'s now-unified role picker built from the live catalog instead of 3 hardcoded checkboxes).

**Approved product decision, implemented exactly as specified**: `updateRole`/`deleteRole` reject an operation that would remove `electionDay.manageRolesAndPermissions` from every *actually-assigned* user (checked against real `election_day_permission_users` rows via a join, never merely a role's existence) - enforced DB-side, inside the same transaction as the write, serialized against concurrent calls via `pg_advisory_xact_lock` (so two simultaneous edits can't both pass the check and jointly leave zero holders). `createRole`/`cloneRole` carry no such restriction (adding/cloning a role can never reduce anyone's access). `deleteRole` additionally rejects (with a friendly `ROLE_HAS_ASSIGNED_USERS` error, ahead of the Phase 0 `ON DELETE RESTRICT` FK backstop) any role that still has assigned users.

**A necessary architecture correction surfaced while implementing this phase**: Phase 1's session resolution (`resolveSessionRole`) matched a session against the live catalog by its **legacy role text** (`legacyRoleKey`). A `PermissionUser` created against an arbitrary dynamic `role_id` (this phase's whole point) has no legacy text at all (`role: null`) - matching by legacy text would either fail to resolve such a session or, worse, coincidentally mis-resolve it against the first `legacyRoleKey: null` row in the catalog. Fixed by switching resolution to match by **`roleId`** instead - `role_id` has been `NOT NULL` on every row (legacy or dynamic) since Phase 0, so this is a strictly more correct single resolution path for every account, not a dual-path special case. This touched `resolveSessionRole.ts`, `computePermissions.ts` (first argument renamed `sessionRoleId`), `usePermissions.ts`, `ElectionDaySessionUser`/`PermissionUser` (both gained a `roleId: string` field; `role` is now `PermissionRole | null`), and the `election_day_login`/`election_day_list_permission_users`/`election_day_create_permission_user` RPCs (all three now also return `role_id`). Every Phase 1 smoke test was updated to key off `BUILT_IN_ROLE_SEED`'s placeholder ids (`seed-manager`/`seed-user`/`seed-voting`) instead of legacy role text - same assertions, same fail-closed contract, just resolved through the corrected path.

**Migration APPLIED** (2026-08-06, to the linked remote project via `supabase db push`; confirmed via `supabase migration list --linked` showing `20260806100000` on both sides): `supabase/migrations/20260806100000_election_day_dynamic_roles_phase2.sql` - adds `election_day_create_role`/`election_day_update_role`/`election_day_delete_role`/`election_day_clone_role`/`election_day_create_permission_user_for_role`, a DB-side permission allowlist (`election_day_is_valid_permission`, mirrors `ALL_PERMISSIONS`) that rejects (never silently drops) an unrecognized permission string on a write, and adds `role_id` to the three existing roster RPCs' return shape (required `DROP FUNCTION` + `CREATE`, not just `CREATE OR REPLACE`, since their `RETURNS TABLE` shape changed).

**A real bug was found and fixed during live verification, before this migration was ever committed**: `election_day_update_role`, `election_day_clone_role`, and `election_day_create_permission_user_for_role` each declare a `returns table (id uuid, ...)` (or `..., role_id uuid)`) - PL/pgSQL treats those output column names as ordinary variables in scope for the whole function body, so a *bare* `id`/`permissions` reference inside (e.g. `where id = p_role_id`, `any(permissions)`) is ambiguous between the table column and the output variable. Postgres raised exactly that live (`column reference "id" is ambiguous"`) on the first verification pass. Fixed by aliasing every such reference to the table (`r.id`, `r.permissions`) in all three functions - `election_day_create_role`/`election_day_delete_role`/`election_day_is_valid_permission`/`election_day_validate_role_input` were already alias-safe (no bare-name collision) and needed no change. The corrected function bodies were applied directly to the same migration (never committed/shipped yet, so this is a pre-commit fix, not a follow-up patch) and to the already-migrated remote (`CREATE OR REPLACE`, idempotent).

**Live-verified against the real database** (2026-08-06, temporary test accounts/roles created via RPC and deleted immediately after, real data never touched) - **37/37 checks passed**:
- Login as manager/operations/`נציג קלפי` via 3 temporary legacy accounts - `election_day_login` returns `role_id` matching the real role's id in every case.
- `election_day_list_permission_users()` returns `role_id` for every row.
- Created a custom role, created a `PermissionUser` against its `role_id` (`role: null` confirmed), logged that user in - `role_id` round-trips correctly end to end.
- Updated the custom role (permissions/scope/description) - changes persisted correctly.
- Cloned the custom role - new id, same permissions/scope, `legacy_role_key: null`.
- Deleting a role with an assigned user was rejected (`ROLE_HAS_ASSIGNED_USERS`); deleting it again after removing the user succeeded; deleting the never-assigned clone succeeded.
- Creating a role with an unrecognized permission string (`sudo.deleteEverything`) was rejected (`INVALID_PERMISSION`).
- **Cleanup verified complete**: `PermissionUser` count returned exactly to its pre-test baseline (4 → 4), no leftover test roles, **1,928 voters unchanged**.

**One residual verification gap, explicitly not resolved**: the `CANNOT_REMOVE_LAST_PERMISSION_HOLDER` guard's *blocking* path (removing `electionDay.manageRolesAndPermissions` from the actual last holder) could not be safely exercised live against production - any temp role/user I create is never the *last* real holder while the real "מנהל" account(s) still hold it, and forcing that scenario would require temporarily mutating a real role or real account, which the standing "never touch real accounts/data" policy for this initiative forbids without fresh explicit approval. The *non-blocking* path (removing the permission from a role when real holders remain elsewhere) is implicitly exercised by every successful `updateRole`/`deleteRole` call above. The guard's SQL (count of `election_day_permission_users` joined to `election_day_roles`, excluding the role being edited) is structurally identical to the already-live-tested `ROLE_HAS_ASSIGNED_USERS` count query, giving reasonable confidence without a live trigger - flagged here rather than silently assumed correct.

**Helper-function lockdown, closed**: `election_day_is_valid_permission`/`election_day_validate_role_input` are internal helpers, only ever called from within `election_day_create_role`/`update_role` (themselves `SECURITY DEFINER`) - a nested call from inside a `SECURITY DEFINER` function checks `EXECUTE` against that function's *owner*, not the original `anon`/`authenticated` caller, so neither helper needs to be (or now is) directly callable by the client. **A live gotcha found while closing this**: `revoke all ... from public` alone did *not* remove `anon`/`authenticated`'s access - `has_function_privilege('anon', ...)` still returned `true` afterward. This Supabase project's default privileges grant `EXECUTE` on every new `public`-schema function directly to `anon`/`authenticated` (not merely via the `PUBLIC` pseudo-role), so revoking only `from public` leaves that direct grant untouched - `anon, authenticated` had to be named explicitly in the `revoke` too. Fixed in the migration file and applied directly to the remote; confirmed via `has_function_privilege` that `anon`/`authenticated`/`public` are all `false` for both helpers now, and re-verified (8/8 checks) that `createRole`/`updateRole`/the `INVALID_PERMISSION` rejection still work correctly end to end (the internal `perform` calls are unaffected, as expected).

**Migration ↔ remote parity, confirmed**: pulled every one of the 10 relevant function bodies from the live database via `pg_get_functiondef` and compared them line-for-line against `supabase/migrations/20260806100000_election_day_dynamic_roles_phase2.sql` - **all 10 match exactly**, including the aliasing fix's comment text. The migration file is an accurate, complete source of truth for what is currently live; nothing was patched on the remote without the matching fix landing in this file first.

**Re-verified locally after both fixes**: `tsc -b` clean, `eslint .` clean (0 errors), `npm run build` clean, `git diff --check` clean (only harmless CRLF notices), all 9 relevant smoke suites pass (`smoke-permissions`, `smoke-permission-logic`, `smoke-permission-ui`, `smoke-bootstrap`, `smoke-role-normalization`, `smoke-role-catalog`, `smoke-election-day-scope`, `smoke-role-seed-parity`, `smoke-role-management-logic`).

**Not yet done, in order**: commit, push, deploy, then a production smoke test - each its own explicit approval gate, same phased pattern as every phase before this one.

### Phase 3 - NOT STARTED

Legacy cleanup: drop `election_day_permission_users.role`, its CHECK constraint, the old `election_day_create_permission_user` RPC, and `legacy_role_key` itself once nothing reads them anymore.

## Approved architectural decisions (do not change without explicit re-approval)

- **No protected roles.** Every role, including the three built-in ones, is fully editable/cloneable/deletable.
- **Protect the permission, not a role name.** "ניהול תפקידים והרשאות" (`electionDay.manageRolesAndPermissions`) must always be held by at least one user - enforced at the DB/RPC level in a future phase, not just client-side.
- **Deleting a role with assigned users is always blocked** - no auto-reassignment, no cascading user deletion. Enforced today at the DB level via `ON DELETE RESTRICT` (Phase 0).
- **"ניהול תפקידים והרשאות" is separate from "ניהול הרשאות משתמשים"** (`electionDay.manageUsers`) - two independent permissions.
- Role fields: name, description, **scope** (תחום עבודה: "כל אנשי הקשר" / "רק המוקצים לי" today, modeled as `scope_type` + reserved `scope_value` so a future dimension, e.g. geographic, is additive, not breaking). "Scope" as a word is never shown in the UI.
- "Clone role" is a required capability.
- Editing an existing user's role is out of scope (stays delete + recreate).
- **Core principle**: the system only knows permissions. `manager`/`operations`/`voting`/any future role are just named permission bundles - there is no "role type" concept in code.
- `legacy_role_key` is a temporary migration-bookkeeping anchor only, identified by a fixed key set once at seed time - never by editable name, never by a hardcoded UUID in application code. Removed entirely in Phase 3.
- Every migration wrapped in explicit `begin;`/`commit;` (the Supabase CLI pipelines a file's statements, it does not implicitly wrap them in a transaction).
- Rollout is 4 independent, individually testable/deployable/rollback-able phases - no big-bang cutover.

## Continuation point

**Phase 1 is complete and closed.** Commit `b3ce9b9` is pushed to `origin/master` and deployed to production (`dpl_BbCLGPtefzD8CzEHvdtApUhsSThQ`, `READY`, `https://kolbox-gamma.vercel.app`). The permission engine now reads roles from the live `election_day_roles` catalog instead of a hardcoded map, fail-closed on every non-"loaded and matched" state, live-verified in production with 0 regressions - 1,928 voters and 5 `PermissionUser` accounts unchanged.

**Phase 2's migration is applied and live-verified (37/37 checks), not yet committed/pushed/deployed.** The role-management UI ("תפקידים" tab), its 5 supporting RPCs, and the necessary session-resolution correction (matching by `roleId`, not legacy text - see above) are all implemented, live-verified against the real database (including a real ambiguous-column bug found and fixed during that verification), and locally re-verified (`tsc`/`eslint`/`build`/9 smoke suites all clean). One residual gap remains explicitly unresolved (the `CANNOT_REMOVE_LAST_PERMISSION_HOLDER` guard's blocking path couldn't be safely live-triggered without touching real account/role data - see above). The continuation point is: commit, push, deploy - each requires its own explicit approval before proceeding, same phased pattern as every prior phase.
