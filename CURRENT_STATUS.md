# KolBox - Current Status

> Single source of truth for "where things stand right now." Update this file whenever production, git HEAD, or an in-flight initiative's phase changes. This file did not exist before 2026-08-05 (confirmed via `git log --all -- CURRENT_STATUS.md` returning no history) - created fresh to anchor the Dynamic Roles & Permissions rollout across sessions.

---

## Production

- **URL**: `https://kolbox-gamma.vercel.app` - live since 2026-07-19. **Serving commit `685d729` (HEAD `3d763da`, which is a documentation-only commit on top of it) - Election Day's 7-screen Shell, Coordinator Allocation, Security Phases 1-3 (legacy RPC retirement complete), the file-management UI fix, the persistent-reminder feature, and the coordinator-sync + voter-filter fixes are all live, as of 2026-08-20.**
- **Vercel project**: `kolbox`, scope `nahom10`, Git integration auto-deploys on push to `master`.
- Current production deployment confirmed live via **content-addressed bundle-hash comparison** (no Vercel CLI/API token available in this environment for this pass - a metadata-based `readyState`/`githubCommitSha` check is not something this session could run; the bundle-identity method below is the substitute): a local `npm run build` of `685d729` produced `index-DL-rwoFO.js`/`index-C04Ed2hO.css`, and Production served the **byte-for-byte identical SHA256 hash** for both files on direct fetch, not just a matching filename. The live JS bundle was independently confirmed to contain the new inferred-coordinator UI strings ("אחראים שזוהו בנתוני הבוחרים" and its hint). **The user then manually verified both fixes live on desktop and mobile** - Allocation Management showing the expected coordinator data, and voter filtering no longer false-emptying - see "Coordinator Sync + Voter Filter Fix" below for the full record.
- **Security Phases 1-3 + Production Rollout - COMPLETE** (2026-08-20) - see its own section below for the full record.
- Everything documented below this line through "Dynamic Roles & Permissions - status" describes older, still-accurate history (closed 2026-08-06 through 2026-08-10). **See "What shipped after Dynamic Roles closed" for 2026-08-06 → 2026-08-10**, and the new sections below it for everything since.

## Coordinator Sync + Voter Filter Fix - CLOSED (2026-08-20) - migration applied, frontend pushed and deployed, both fixes manually verified live

**Both fixes are closed.** The migration is live in Production; the frontend commit (`685d729`, "fix: sync election coordinators and repair voter filters") is pushed to `origin/master` and deployed - the live bundle was byte-for-byte hash-matched to a local build of HEAD `3d763da` (which contains `685d729`). The user then manually verified both fixes against real Production, on desktop and mobile: (1) Allocation Management shows the expected responsible/coordinator data, (2) voter filtering returns the expected results and no longer false-empties. This manual pass was performed by the user directly, not by an automated/agent browser session - see "Rollout completed" below for exactly what each party checked.

**Committed and deployed files** (commit `685d729`): `src/features/election-day/CoordinatorRosterEditor.tsx`, `coordinatorAllocationStats.ts`, `election-day.constants.ts`, `useElectionDay.ts`, and the migration `supabase/migrations/20260820000000_election_day_import_coordinator_sync.sql`.

**Production migration - APPLIED AND VERIFIED** (2026-08-20, via `supabase db push` against the linked Production project `nbymfgphnsounqncfjgl`, preceded by a clean preflight: all 41 prior migrations `local == remote`, only this one pending, Git state exact): applied in a single clean run, no errors, no partial state. Read-only verification immediately after, straight against Production:
- `election_day_voters` count: **1,420** - unchanged, confirming the migration's `election_day_import_voters_v2` change did not touch existing voter rows (it only affects *future* imports).
- `election_day_coordinators` count: **5** - exactly the expected backfill, no more, no less: **חיה, נועם, קארן, לוסיאנה, עדי**, every one `status = active`, `linked_assignment_name = null`, and sharing the identical `created_at` timestamp (`2026-08-20T09:38:43.336907+00:00`) - confirms all 5 were inserted together by the migration's own one-time backfill statement, not individually or by some other path.
- No duplicates, no unexpected rows, no ended-coordinator reactivation (there were zero pre-existing coordinator rows to reactivate in the first place - baseline was 0).
- Migration history re-confirmed: **42/42 migrations `local == remote`, zero drift, zero pending.**
- No anomaly detected at any verification step.

**Fix 1 - Coordinator sync**: "ניהול הקצאות" started with an empty coordinator roster even when the imported voter file's `אחראי` column already named real coordinators, forcing a manager to retype every name. An earlier draft that auto-wrote coordinators silently the instant the screen opened (popping an unprompted reauth password dialog) was explicitly rejected on review and reverted - opening the screen must stay fully read-only. The adopted design: `CoordinatorRosterEditor.tsx` shows a read-only "אחראים שזוהו בנתוני הבוחרים" section (pure `useMemo` via the new `resolveMissingCoordinatorNames`, zero DB calls on render) listing every distinct/trimmed/non-empty `voter.coordinator` not yet represented by an existing coordinator, each with a one-click "הוסף" button that reuses the exact existing add/permission/reauth path - never a bulk "add all". The migration adds a private, anon/authenticated-locked-down helper `election_day_sync_coordinators_from_voters()` (INSERT-only; never reactivates an `ended` coordinator; never touches `linked_assignment_name`; skips a name already used by any coordinator in any status) called from inside `election_day_import_voters_v2` in the same transaction right after every future import, plus a one-time idempotent backfill statement for whatever's already in Production today.

**Concurrency hardening found and closed during review**: `election_day_manage_coordinators_v2` never took the shared `election_day_voter_allocation_mutation` advisory lock (correctly, at the time - it never touched `election_day_coordinators` from within a lock-holding transaction). This change's own import-time sync breaks that premise, so `election_day_manage_coordinators_v2` now takes the same lock, in the same relative position the other 3 allocation v2 RPCs already use. Empirically verified bidirectionally with two genuinely concurrent local `psql` sessions - a call on one side measurably blocked (~3.4-3.5s) until the other's transaction committed, in both directions, no deadlock, no duplicate/collision rows.

**Fix 2 - Voter filter false-empty bug**: `useElectionDay.ts`'s `followUpFilter` (default `["remaining"]`) was applied unconditionally, so picking a "closed"-type non-voting reason while that default was still active silently intersected to zero results (`לא נמצאו התאמות` shown even though matching voters existed). `setReasonFilter` now clears the untouched default in that case (mirrors the existing `setVoteStatusFilter` pattern exactly); `hasActiveFilters` now compares `voteStatusFilter`/`followUpFilter` against their real defaults instead of a bare `.length > 0`, so the empty-state message is accurate. No authorization/voter-scope logic touched.

**Verified locally before the Production apply**: 3 full `npx supabase db reset` replays (Docker, all 42 migrations) with zero errors; the bidirectional concurrency test above; a forced NOT-NULL-violation test confirming voter import and coordinator sync roll back together atomically; permission/reauth regression checks unchanged (`FORBIDDEN` still correctly raised, zero mutation on every failure path); `tsc -b`/`npm run build`/`eslint`/`git diff --check` all clean.

**Production read-only baseline before the migration** (nothing written at that point): **1,420 voters**, **0 persisted coordinators**, **5 distinct missing coordinator names** - חיה, נועם, קארן, לוסיאנה, עדי. This confirms the previously-documented "1,928 voters" figure elsewhere in this file was already stale for the voter-count purpose (kept below only as historical record of when it was true) before this migration ever ran.

**Rollout completed**: `git push` of `685d729` + the documentation-sync commit that recorded the Production apply → Vercel auto-deploy confirmed → live bundle byte-for-byte SHA256-matched to a local build of HEAD (both the JS and CSS assets identical, not just filename/hash-in-URL matching) → the two new inferred-coordinator UI strings ("אחראים שזוהו בנתוני הבוחרים" and its hint) confirmed present in the live bundle via direct grep → **the user then manually exercised both fixes against real Production on desktop and mobile and confirmed both pass**: Allocation Management shows the expected responsible/coordinator data, and voter filtering returns the expected results with no more false "לא נמצאו התאמות". Final read-only DB check after all of the above: still 1,420 voters, still exactly the same 5 coordinators, 42/42 migrations `local == remote`, zero drift, zero pending, no anomaly. **Both Issue 1 (coordinator sync) and Issue 2 (voter filter false-empty) are closed.**

## Git

- Branch: `master`
- HEAD: `2b187c2` ("docs: update election day production checkpoint") - the latest documentation checkpoint, confirmed documentation-only (`CHANGELOG.md`/`CURRENT_STATUS.md`/`task-plan.md` only, no app/DB/script files) via `git show --stat --summary 2b187c2`.
- `origin/master...master`: `0 / 0` - fully synced
- Working tree: the same 16 pre-existing, harmless dirty scripts (`scripts/drive-*.mjs`, `scripts/smoke-*.ts`) as every prior checkpoint - audited read-only, none perform a live mutating RPC against real data, deliberately left untouched/uncommitted across every session since they were first found.

Recent history (newest first, since `6f9f3f4` - see `CHANGELOG.md` for full detail on each):

```
2b187c2 docs: update election day production checkpoint
98fde6c feat: keep election reminders visible until handled
8e519be fix: refine election day file management actions
20946c0 security: retire legacy election day RPCs (Phase 3)
07221b8 security: migrate election day allocation to reauth proofs
67b098a security: harden election day admin authentication
8d7ce3d feat: add election day allocation management ui
d51c599 feat: grant coordinator allocation permission to manager
441358f feat: add election day allocation frontend data layer
02d0e45 feat: add election day allocation rpc core
6d3379a feat: support safe unassigned voter imports
49b755b feat: add election day allocation db foundation
53872e8 refactor: compact call attempts watchlist by coordinator
abdc4c1 feat: harden election day call attempts tracking
6a1391a fix: clarify non-voting reason placeholder
d7f8ee1 feat: add call attempts watchlist to election dashboard
db6efb4 fix: add election day vote status filter
8e1f909 docs: sync election day production documentation
6f9f3f4 test: harden production smoke test safety   <- this file's old "current" point
```

Note: the coordinator-allocation feature (`49b755b` through `8d7ce3d` - DB foundation, RPC core, frontend data layer, manager permission grant, management UI) and the call-attempts/vote-status-filter/watchlist commits above landed between the last documentation pass and this one without their own `CURRENT_STATUS.md`/Progress Log entries; `CHANGELOG.md` and `git log` are the accurate record for their detail - not reconstructed here to avoid inventing detail this update wasn't briefed on.

## Current Supabase migrations (41 total, confirmed `local` = `remote`, zero drift, via `npx supabase migration list --linked`, 2026-08-20)

```
20260803174712_election_day_core_tables.sql
20260803174722_election_day_core_rls.sql
20260803174731_election_day_permission_users.sql
20260803174740_election_day_permission_rpc.sql
20260803174751_election_day_realtime.sql
20260803192810_election_day_voters_phone_optional.sql
20260803203025_election_day_atomic_import.sql
20260803210234_election_day_atomic_import_where_fix.sql
20260805150834_election_day_voting_role.sql
20260805181806_election_day_dynamic_roles_phase0.sql
20260805190000_election_day_list_roles_rpc.sql
20260806100000_election_day_dynamic_roles_phase2.sql
20260806150000_election_day_dynamic_roles_phase3.sql
20260806160000_election_day_not_voting_reasons_table.sql
20260806161000_election_day_voters_not_voting_reason_column.sql
20260806162000_election_day_not_voting_reasons_rpc.sql
20260806170000_election_day_valid_permission_non_voting_reasons.sql
20260806180000_election_day_not_voting_reasons_requires_follow_up.sql
20260806190000_election_day_call_attempts.sql
20260806200000_election_day_reset_permission_user_password.sql
20260806210000_election_day_reset_permission_user_password_fix.sql
20260810120000_election_day_reminder_lifecycle.sql
20260810130000_election_day_set_non_voting_reason_security_definer_fix.sql
20260810140000_election_day_valid_permission_reminder_history.sql
20260811090000_election_day_call_attempts_guard.sql
20260811100000_election_day_coordinator_nullable.sql
20260811100100_election_day_coordinators_table.sql
20260811100200_election_day_coordinator_operations_tables.sql
20260811100300_election_day_coordinators_realtime.sql
20260811100400_election_day_valid_permission_coordinator_allocation.sql
20260812090000_election_day_has_allocation_activity.sql
20260812090100_election_day_import_voters_allocation_guard.sql
20260812090200_election_day_reminder_lifecycle_null_coordinator_hardening.sql
20260813100000_election_day_manage_coordinators_rpc.sql
20260813100100_election_day_coordinator_allocation_rpcs.sql
20260813100200_election_day_import_voters_allocation_lock.sql
20260813100300_election_day_manager_coordinator_allocation_permission.sql
20260813110000_election_day_reauth_proof_infrastructure.sql
20260813110100_election_day_admin_v2_rpcs.sql
20260813120000_election_day_allocation_v2_rpcs.sql
20260813130000_election_day_retire_legacy_rpcs.sql
```

The last four (`20260813110000` → `20260813130000`) are the Security Phases 1-3 migrations - see the next section.

## What shipped after Dynamic Roles closed (2026-08-06 → 2026-08-10)

Full detail lives in `CHANGELOG.md` (backfilled 2026-08-10) and `task-plan.md`'s Progress Log. High-level summary, oldest first:

- **Call-attempts counter + no-answer dialog** (`8045f0e`) and a **sub-10% turnout display precision fix** (`d52c933`) - 2026-08-06.
- **Secure password reset for permission users** (`da198ef`) - 2026-08-07. The one roster RPC with real caller re-authentication (bcrypt-verifies the acting manager, not just a client-side check) - every other roster RPC has no caller-identity check at all.
- **Election Day rebuilt as a 7-screen router Shell** (`7f5381d`, preceded by a short-lived nav-accordion iteration in `a2c9977`/`e6eef0d`/`7455cb0` that it fully replaced) and **merged into the main app's own sidebar** as a "יום הבחירות" section (`d4ff25a`) - 2026-08-07. Election Day is no longer a single screen: `/election-day/{dashboard,voters,files,permissions,rides,reasons,reports}`, own persistent nav, data/mutations shared across screens via router outlet context.
- **Dashboard redesign**: closed-reason breakdown row (`89298ac`) then a full redesign from an approved Trello mockup adding a coordinator-performance table, turnout-pace chart, and attention-alerts panel (`4bd7db6`) - 2026-08-08. Live-browser-verified 2026-08-10 (desktop 1400px + mobile 375px screenshots against real production data).
- **Two distinct mobile-overflow bugs**, fixed a day apart: the shared bottom-nav component (`ea31937`) and the new dashboard's grid-nested cards + countdown boxes (`812092b`) - 2026-08-09.
- **User-deletion hardening** (`b682594`: confirm dialog, self-delete protection at 2 layers, still client-side only) and **permissions-UI visibility hardening** (`0a0343b`: Add/Reset/Delete fully hidden, not just disabled, for a non-`manageUsers` session) - 2026-08-10.
- **Reminder Lifecycle v1** (`6635aad`) - a full FUTURE/DUE/CLOSED/CANCELLED state machine replacing the old single `reminder_at` column, with a follow-up security-definer bug fix the same day - 2026-08-10.
- **Production Smoke Test Safety Hardening** (`6f9f3f4`) - built in direct response to a production incident during the Reminder Lifecycle smoke test (2 real voters briefly mutated, surgically recovered). Permanent new rule + module (`scripts/lib/productionTestSafety.ts`) now governs every future production-mutating test script. **Reminder Lifecycle v1 smoke-tested clean under this protocol immediately after (63/63) - milestone is production complete.**

**A gap surfaced by this documentation audit itself was found and fixed the same day**: `voter.viewReminderHistory` (the permission added by `6635aad`) was missing from the DB-side `election_day_is_valid_permission` write-path allowlist - the same bug class as the already-fixed `electionDay.manageNonVotingReasons` gap above. Fixed via migration `20260810140000_election_day_valid_permission_reminder_history.sql` (applied to the linked remote project the same day): delta verified to be exactly `+voter.viewReminderHistory`, no other permission touched. Post-fix production verification: `election_day_create_role` now accepts the permission on a disposable test role (created, confirmed, then deleted) while still rejecting a fake permission literal; baseline unchanged (1928 voters / 5 roles / 4 accounts / 0 open reminders / 0 events).

**A separate, unrelated finding from the same session**: a subagent's tool output was flagged for printing the live Vercel CLI personal token; remediated the same day via `vercel logout` (server-side invalidation, not just a local credential wipe) plus a repo-wide secret-residue scan (clean). Re-authenticating the CLI requires an interactive step only the project owner can do - not yet done as of this update. See CLAUDE.md's "Resolved: Vercel CLI credential exposure" for the full record.

## Election Day Permission Engine - status

The `manager` / `operations` / `voting` permission engine (`src/permissions/`) is live in production, connected to every Election Day UI surface and to the `useElectionDay.ts` mutation layer (`guardedAction`). `voting` is a real, loggable-in DB role (Stage 4, commit `b739f4b`), UI-labeled "נציג קלפי" (commit `6080d05`). This milestone is closed - see `task-plan.md`'s Progress Log for the full history. It is documented there; the initiative below is not yet.

## Dynamic Roles & Permissions - status

**CLOSED - all 4 phases shipped, deployed, and live-verified in production.** Replaced the hardcoded 3-role permission engine with a DB-backed, fully editable role catalog (create/rename/delete/clone roles, assign arbitrary permission sets) and removed every piece of the legacy `manager`/`operations`/`voting` scaffolding (`legacy_role_key`, the `role` text column, the 3-checkbox creation RPC) once nothing depended on it anymore. Phases 0-3 are all shipped and documented in `CHANGELOG.md`. **None of this is yet written up in `task-plan.md`**'s Progress Log - this file remains the most current/detailed source of truth for this initiative regardless.

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

### Phase 2 - COMPLETE (shipped, in production)

Real role management: a "תפקידים" UI tab (`RoleManagementModal.tsx` + `useRoleManagement.ts`), RPCs to create/update/delete/clone a role, and a new RPC to create a `PermissionUser` against an arbitrary `role_id` (not just the 3 legacy checkboxes, via `PermissionUsersModal.tsx`'s now-unified role picker built from the live catalog instead of 3 hardcoded checkboxes).

**Approved product decision, implemented exactly as specified**: `updateRole`/`deleteRole` reject an operation that would remove `electionDay.manageRolesAndPermissions` from every _actually-assigned_ user (checked against real `election_day_permission_users` rows via a join, never merely a role's existence) - enforced DB-side, inside the same transaction as the write, serialized against concurrent calls via `pg_advisory_xact_lock` (so two simultaneous edits can't both pass the check and jointly leave zero holders). `createRole`/`cloneRole` carry no such restriction (adding/cloning a role can never reduce anyone's access). `deleteRole` additionally rejects (with a friendly `ROLE_HAS_ASSIGNED_USERS` error, ahead of the Phase 0 `ON DELETE RESTRICT` FK backstop) any role that still has assigned users.

**A necessary architecture correction surfaced while implementing this phase**: Phase 1's session resolution (`resolveSessionRole`) matched a session against the live catalog by its **legacy role text** (`legacyRoleKey`). A `PermissionUser` created against an arbitrary dynamic `role_id` (this phase's whole point) has no legacy text at all (`role: null`) - matching by legacy text would either fail to resolve such a session or, worse, coincidentally mis-resolve it against the first `legacyRoleKey: null` row in the catalog. Fixed by switching resolution to match by **`roleId`** instead - `role_id` has been `NOT NULL` on every row (legacy or dynamic) since Phase 0, so this is a strictly more correct single resolution path for every account, not a dual-path special case. This touched `resolveSessionRole.ts`, `computePermissions.ts` (first argument renamed `sessionRoleId`), `usePermissions.ts`, `ElectionDaySessionUser`/`PermissionUser` (both gained a `roleId: string` field; `role` is now `PermissionRole | null`), and the `election_day_login`/`election_day_list_permission_users`/`election_day_create_permission_user` RPCs (all three now also return `role_id`). Every Phase 1 smoke test was updated to key off `BUILT_IN_ROLE_SEED`'s placeholder ids (`seed-manager`/`seed-user`/`seed-voting`) instead of legacy role text - same assertions, same fail-closed contract, just resolved through the corrected path.

**Migration APPLIED** (2026-08-06, to the linked remote project via `supabase db push`; confirmed via `supabase migration list --linked` showing `20260806100000` on both sides): `supabase/migrations/20260806100000_election_day_dynamic_roles_phase2.sql` - adds `election_day_create_role`/`election_day_update_role`/`election_day_delete_role`/`election_day_clone_role`/`election_day_create_permission_user_for_role`, a DB-side permission allowlist (`election_day_is_valid_permission`, mirrors `ALL_PERMISSIONS`) that rejects (never silently drops) an unrecognized permission string on a write, and adds `role_id` to the three existing roster RPCs' return shape (required `DROP FUNCTION` + `CREATE`, not just `CREATE OR REPLACE`, since their `RETURNS TABLE` shape changed).

**A real bug was found and fixed during live verification, before this migration was ever committed**: `election_day_update_role`, `election_day_clone_role`, and `election_day_create_permission_user_for_role` each declare a `returns table (id uuid, ...)` (or `..., role_id uuid)`) - PL/pgSQL treats those output column names as ordinary variables in scope for the whole function body, so a _bare_ `id`/`permissions` reference inside (e.g. `where id = p_role_id`, `any(permissions)`) is ambiguous between the table column and the output variable. Postgres raised exactly that live (`column reference "id" is ambiguous"`) on the first verification pass. Fixed by aliasing every such reference to the table (`r.id`, `r.permissions`) in all three functions - `election_day_create_role`/`election_day_delete_role`/`election_day_is_valid_permission`/`election_day_validate_role_input` were already alias-safe (no bare-name collision) and needed no change. The corrected function bodies were applied directly to the same migration (never committed/shipped yet, so this is a pre-commit fix, not a follow-up patch) and to the already-migrated remote (`CREATE OR REPLACE`, idempotent).

**Live-verified against the real database** (2026-08-06, temporary test accounts/roles created via RPC and deleted immediately after, real data never touched) - **37/37 checks passed**:

- Login as manager/operations/`נציג קלפי` via 3 temporary legacy accounts - `election_day_login` returns `role_id` matching the real role's id in every case.
- `election_day_list_permission_users()` returns `role_id` for every row.
- Created a custom role, created a `PermissionUser` against its `role_id` (`role: null` confirmed), logged that user in - `role_id` round-trips correctly end to end.
- Updated the custom role (permissions/scope/description) - changes persisted correctly.
- Cloned the custom role - new id, same permissions/scope, `legacy_role_key: null`.
- Deleting a role with an assigned user was rejected (`ROLE_HAS_ASSIGNED_USERS`); deleting it again after removing the user succeeded; deleting the never-assigned clone succeeded.
- Creating a role with an unrecognized permission string (`sudo.deleteEverything`) was rejected (`INVALID_PERMISSION`).
- **Cleanup verified complete**: `PermissionUser` count returned exactly to its pre-test baseline (4 → 4), no leftover test roles, **1,928 voters unchanged**.

**One residual verification gap, explicitly not resolved**: the `CANNOT_REMOVE_LAST_PERMISSION_HOLDER` guard's _blocking_ path (removing `electionDay.manageRolesAndPermissions` from the actual last holder) could not be safely exercised live against production - any temp role/user I create is never the _last_ real holder while the real "מנהל" account(s) still hold it, and forcing that scenario would require temporarily mutating a real role or real account, which the standing "never touch real accounts/data" policy for this initiative forbids without fresh explicit approval. The _non-blocking_ path (removing the permission from a role when real holders remain elsewhere) is implicitly exercised by every successful `updateRole`/`deleteRole` call above. The guard's SQL (count of `election_day_permission_users` joined to `election_day_roles`, excluding the role being edited) is structurally identical to the already-live-tested `ROLE_HAS_ASSIGNED_USERS` count query, giving reasonable confidence without a live trigger - flagged here rather than silently assumed correct.

**Helper-function lockdown, closed**: `election_day_is_valid_permission`/`election_day_validate_role_input` are internal helpers, only ever called from within `election_day_create_role`/`update_role` (themselves `SECURITY DEFINER`) - a nested call from inside a `SECURITY DEFINER` function checks `EXECUTE` against that function's _owner_, not the original `anon`/`authenticated` caller, so neither helper needs to be (or now is) directly callable by the client. **A live gotcha found while closing this**: `revoke all ... from public` alone did _not_ remove `anon`/`authenticated`'s access - `has_function_privilege('anon', ...)` still returned `true` afterward. This Supabase project's default privileges grant `EXECUTE` on every new `public`-schema function directly to `anon`/`authenticated` (not merely via the `PUBLIC` pseudo-role), so revoking only `from public` leaves that direct grant untouched - `anon, authenticated` had to be named explicitly in the `revoke` too. Fixed in the migration file and applied directly to the remote; confirmed via `has_function_privilege` that `anon`/`authenticated`/`public` are all `false` for both helpers now, and re-verified (8/8 checks) that `createRole`/`updateRole`/the `INVALID_PERMISSION` rejection still work correctly end to end (the internal `perform` calls are unaffected, as expected).

**Migration ↔ remote parity, confirmed**: pulled every one of the 10 relevant function bodies from the live database via `pg_get_functiondef` and compared them line-for-line against `supabase/migrations/20260806100000_election_day_dynamic_roles_phase2.sql` - **all 10 match exactly**, including the aliasing fix's comment text. The migration file is an accurate, complete source of truth for what is currently live; nothing was patched on the remote without the matching fix landing in this file first.

**Re-verified locally after both fixes**: `tsc -b` clean, `eslint .` clean (0 errors), `npm run build` clean, `git diff --check` clean (only harmless CRLF notices), all 9 relevant smoke suites pass (`smoke-permissions`, `smoke-permission-logic`, `smoke-permission-ui`, `smoke-bootstrap`, `smoke-role-normalization`, `smoke-role-catalog`, `smoke-election-day-scope`, `smoke-role-seed-parity`, `smoke-role-management-logic`).

**Committed, pushed, and deployed** (2026-08-06): commit `92e8162` ("feat: add dynamic role management (Phase 2)"), pushed to `origin/master` (0 ahead/0 behind), deployed to production as `dpl_GCJJkBDLJWtDHm4AEYguCbJiYP3C` (`READY`, `https://kolbox-gamma.vercel.app`, built ~1 minute after the push).

**Production smoke test - PASSED** (2026-08-06, full Playwright run against `https://kolbox-gamma.vercel.app`, 4 temporary `PermissionUser` accounts + 1 temporary role created via RPC/UI and removed immediately after) - **27/27 checks passed**: manager login through the real UI saw the full 1,928-contact dataset and every admin control; opened the "תפקידים" tab and saw the 3 built-in roles with their legacy badge; created a role through the UI, edited its scope to "כל אנשי הקשר", cloned it, deleted the clone (no users) successfully; created a `PermissionUser` against the custom role through the now-unified role picker in "ניהול הרשאות משתמשים" (roster correctly showed the custom role's real name, never "תפקיד לא ידוע"); the delete button for the custom role became disabled once a user was assigned to it; logged out and logged in as that dynamic-role account - saw the full dataset (`scope_type: "all"` took effect) but none of the admin-only buttons it wasn't granted; 0 critical console/page errors. **Cleanup verified complete**: `PermissionUser` count returned exactly to baseline, no leftover test roles, **1,928 voters unchanged**.

**Phase 2 is fully closed**: code implemented, migration applied, live-verified pre-commit (37/37) and post-deploy in production (27/27), committed, pushed, deployed, zero regressions. The one residual gap (`CANNOT_REMOVE_LAST_PERMISSION_HOLDER`'s blocking path, see above) remains explicitly documented, not silently assumed resolved.

### Phase 3 - COMPLETE (shipped, in production)

Legacy cleanup migration `supabase/migrations/20260806150000_election_day_dynamic_roles_phase3.sql` **applied** to the linked remote Supabase project (2026-08-06): `election_day_permission_users.role` (+ its CHECK constraint) and `election_day_roles.legacy_role_key` (+ its partial unique index) are dropped; the old `election_day_create_permission_user(text,text,text)` RPC and `election_day_create_permission_user_for_role(text,text,uuid)` are both dropped; a new `election_day_create_permission_user(text,text,uuid)` takes the freed-up short name (found and fixed mid-verification: the migration file as originally written never actually performed this rename - corrected directly against remote, then the migration file updated to match, before it was committed anywhere). `election_day_login`/`list_permission_users`/`create_role`/`update_role`/`clone_role`/`list_roles` are re-created without `role`/`legacy_role_key` in their return shape; `election_day_delete_role` was untouched (never referenced either column). Verified live: legacy columns/functions gone, new RPC's signature/`SECURITY DEFINER`/`search_path=""` correct, `anon`/`authenticated` EXECUTE grants intact on every roster RPC, `PUBLIC` denied throughout, internal helpers (`election_day_is_valid_permission`/`election_day_validate_role_input`) still locked down to nobody but their SECURITY DEFINER callers.

All application code updated to match: `RoleRecord.legacyRoleKey`/`DatabaseRole`/`PermissionRole` types removed; `PermissionUser`/`NewPermissionUser` no longer carry a `role` field; `addPermissionUser`/`createPermissionUserForRole` merged into a single `createPermissionUser(name, password, roleId)` path; `PermissionUsersModal.tsx`'s `legacyRoleKey`-branching removed; `RoleManagementModal.tsx`'s "תפקיד מובנה" badge removed (no role carries any special marking in code); `election-day.constants.ts`'s dead `roleOptions`/`legacyBadge` removed. Test suite updated to match (seed-parity/normalization/scope fixtures no longer reference `legacyRoleKey`/`legacy_role_key`; the one-off, self-documented-as-deletable `smoke-role-live-db-parity.ts` was deleted). `npm run build` (tsc + vite), `npm run lint`, and all 10 smoke suites pass with 0 errors.

**Committed, pushed, and deployed** (2026-08-06): commit `2e8191c` ("feat: remove legacy role model (Phase 3)", 24 files changed, 485 insertions(+)/431 deletions(-)), pushed to `origin/master` (0 ahead/0 behind), deployed to production as `dpl_DvJscBWx42YSKQRQHdyDEbKwmP5p` (`READY`, `https://kolbox-gamma.vercel.app`, built ~24 seconds after the push).

**Live-verified twice**: once locally (dev server against the freshly-migrated remote DB, before commit) - login as manager/operations/a brand-new dynamic role, create/edit/clone/delete a role, create a `PermissionUser` against a dynamic role, delete-blocked-while-assigned, logout/login round-trip, **23/23 checks passed**; once against production after deploy - the same suite plus an explicit check that creating a `PermissionUser` via the renamed RPC works again, **20/20 checks passed**. Both runs: 0 console errors, real 1,928-voter dataset and `PermissionUser` roster (baseline 0) unchanged after cleanup.

**A real, disclosed transient risk existed and is now closed**: between the migration apply and this deploy, the still-live old frontend (commit `461f6b0`) called two now-dropped RPC names for creating a `PermissionUser`, so that one action would have failed on production during that window. Confirmed closed by the post-deploy production smoke test's explicit regression check for exactly this case.

**Phase 3 is fully closed - and with it, the entire Dynamic Roles & Permissions initiative.** No `legacy_role_key`, no legacy `role` column, no 3-checkbox creation RPC, no hardcoded `manager`/`operations`/`voting` special-casing anywhere in code - every role, built-in or custom, is an ordinary `election_day_roles` row identified only by `id`/`roleId` and judged only by its `permissions`/`scopeType`.

## Security Phases 1-3 (legacy RPC retirement) + Production Rollout - status

**COMPLETE, deployed, verified, closed as of 2026-08-20.** Not to be confused with Dynamic Roles & Permissions' own "Phase 3" above - this is a separate, later initiative: closing the gap where several admin/import/coordinator-allocation RPCs took a raw `p_actor_id`/`p_actor_password` pair (or, for `election_day_import_voters`, no auth at all) instead of the short-lived reauth-proof pattern `election_day_reset_permission_user_password` already used.

- **Phase 1** (commit `67b098a`, "security: harden election day admin authentication"): added `election_day_reauth_proof_infrastructure` (a table-backed, ~15-minute proof token replacing repeated raw-password transmission) plus 8 new `_v2` RPCs (create/delete permission user, reset password, create/update/delete/clone role, import voters) - each a brand-new `pg_proc` object (never a `CREATE OR REPLACE` over the original, since Postgres function identity is name+argtypes and a rename mid-flight would have broken the compatibility window), same business logic as the v1 original, with a proof/permission check added strictly before any mutation.
- **Phase 2** (commit `07221b8`, "security: migrate election day allocation to reauth proofs"): same pattern extended to the 4 coordinator-allocation RPCs (`manage_coordinators`, `apply_initial_allocation`, `rebalance_assignments`, `end_coordinator_activity`) as `_v2` siblings, preserving the existing global advisory-lock concurrency ordering exactly.
- **Phase 3** (commit `20946c0`, "security: retire legacy election day RPCs"): `REVOKE EXECUTE` (not `DROP` - bodies kept intact for one-step rollback) on all 12 original v1 RPCs from `anon`/`authenticated`, via an **Expand → Deploy → Contract** rollout (migrate schema with both v1 and `_v2` live → push/deploy the `_v2`-only frontend → confirm the new frontend is actually serving → only then retire v1) specifically to avoid a window where a not-yet-deployed frontend still calling v1 would break.

**Rollout execution** (2026-08-20): migrations `20260813110000` through `20260813120000` applied first (Expand); `git push` + Vercel auto-deploy confirmed live via bundle-hash match; only then `20260813130000` applied (Contract). Runtime-verified via `has_function_privilege` directly against the linked Production database (not inferred): all 12 legacy RPCs now `EXECUTE = false` for both `anon` and `authenticated`; all 12 `_v2` RPCs `EXECUTE = true`. Migration history reconfirmed `local` = `remote` on all 41 rows, zero drift. One local-runtime-only hiccup during rollout: the `db push` CLI hung on exit after the Expand step had already fully and correctly applied (confirmed via `migration list`/lock/long-running-query checks before touching anything) - terminated cleanly, not retried, no partial state.

**Verification performed, not just claimed**: a full local Postgres replay (Docker + `npx supabase db reset`, all 43-then-41 migrations reapplied clean) before touching Production; a Final Gate (typecheck/build/lint/`git diff --check`/migration-ordering/signature-cross-check, all pass) before rollout began; live `has_function_privilege` checks against Production both mid-rollout (Expand-state: legacy still callable) and post-rollout (Contract-state: legacy revoked) - not a single claim in this section rests on documentation-only or "should work" reasoning.

**Read-only closure audit findings** (2026-08-20, same day): Production's permission-users count (7, not the previously-documented 4) and an earlier migration-count discrepancy in this session's own interim reports (40 vs. 41) were both investigated and closed - the account growth traced to 5 real accounts created by a human via the UI on 2026-08-15 (unrelated to this rollout, confirmed via `created_at` timestamps and a full grep of every rollout migration for any `INSERT` into the permission-users table - none found outside a normal RPC function body); the migration-count mismatch was this session's own arithmetic error in an earlier status report, not a real drift (re-verified programmatically: 41/41, zero mismatch, both before and after).

## File Management UI fix + Persistent Reminders - status

**Both COMPLETE, deployed, and verified as of 2026-08-20** - two small, independent UI features shipped back-to-back after the security rollout above, no DB/RPC/migration involvement in either.

**File-management screen** (commit `8e519be`, "fix: refine election day file management actions") - `/election-day/files`: reordered cards to טען קובץ בוחרים → מחק קובץ בוחרים → ניהול הקצאות (last); each card's separate action button was removed and the card itself became the click target (`ElectionDayImportButton.tsx` rewritten, `ElectionDayFilesPage.tsx`'s delete/allocation cards converted to plain full-card `<button>`s); idle state is neutral/white for all three; the active/press indicator is a vertical blue accent stripe on the right (RTL start) edge (`border-s-4 border-s-transparent` at rest, `border-s-primary-500` on `:active`/`:focus-visible`) - a deliberate iteration after an initial full-ring version was explicitly rejected as not matching the requested "stripe" look. No business logic, dialogs, or permission changes.

**Persistent Reminders** (commit `98fde6c`, "feat: keep election reminders visible until handled") - replaces the old reminder-due notification (a generic `toast.info()` that auto-dismissed after 4s via `components/ui/Toast.tsx`, pure in-memory state, gone on reload) with a compact bar: "⏰ יש לך N תזכורות לטיפול", pinned to the physical LEFT edge (an explicit, commented, product-approved exception to this codebase's usual RTL-logical-property convention), click to expand into up to 5 reminder cards (oldest-`reminderAt`-first) + "עוד N תזכורות" if more exist, click again to collapse. New files `overdueReminderPopups.ts` (pure derivation: DUE and not `lastCallAttemptAt >= reminderAt`) and `OverdueReminderStack.tsx`; `useElectionDay.ts` gained `scopedContacts` in its return and lost the old toast-interval effect; rendered once at the `ElectionDayShell` level so it persists across all 7 screens. "Handled by call" reuses the existing `incrementCallAttempts` RPC's own `last_call_attempt_at` write - no new column. "דחה" (postpone) reuses the existing `ReminderMenu` component as-is, wired to the existing `setReminder`/`setReminderAt`. Manager exclusion uses the resolved role's existing `scopeType` field (`"assigned_to_me"` required, same signal `electionDayScope.ts` already uses elsewhere) - not a role name/id check, so it generalizes to any future unrestricted role, not just today's "manager." A real bug was found and fixed during verification (not a pre-existing issue): with several cards expanded, one card's "דחה" dropdown could render underneath the next card in the list (a CSS stacking-context collision from stacking multiple `ReminderMenu` instances, never exercised before this feature existed) - fixed with a scoped `relative z-0 focus-within:z-30` on each card wrapper, without touching `ReminderMenu.tsx` itself.

Full local functional verification (disposable local-only Supabase accounts/contacts, created and deleted every round): manager sees no bar; a scoped user does; 7 overdue → bar reads 7, expands to 5 + "עוד 2"; oldest-first confirmed; a call decrements the count and removes that card; postpone decrements the count until the new time; the bar/count survives a full page reload and screen navigation; desktop (1440px) and mobile (390px) both verified via screenshots. Production verification was necessarily narrower - no Production data mutation or test account was permitted, so **authenticated in-app reminder behavior was not directly exercised live**; what *was* verified against Production is that the exact code proven correct locally is what's actually deployed (bundle-hash match to the local build of `98fde6c`, plus a direct grep of the live bundle confirming the new bar-label strings/CSS classes are present and the old toast string is absent).

**Incidental, out-of-scope finding, explicitly not fixed** (flagged for whoever picks it up, see "Standing open items" below): several existing buttons across the contact modal and both new features (call/reschedule/close-reminder, using an arbitrary-value `bg-[#00a400]`/`bg-[#f59f00]` layered on `<Button>`'s default `variant="primary"`) render as plain primary/purple instead of their intended green/orange, because `cn()` (`src/lib/utils.ts`) is plain `clsx` with no Tailwind-merge conflict resolution. Confirmed pre-existing (present in the shipped contact modal itself, not introduced by either feature above) - deliberately not touched, since fixing it only in new code would make the new UI disagree with the old modal's colors for the same actions.

## Approved architectural decisions (do not change without explicit re-approval)

- **No protected roles.** Every role, including the three built-in ones, is fully editable/cloneable/deletable.
- **Protect the permission, not a role name.** "ניהול תפקידים והרשאות" (`electionDay.manageRolesAndPermissions`) must always be held by at least one user - enforced at the DB/RPC level in a future phase, not just client-side.
- **Deleting a role with assigned users is always blocked** - no auto-reassignment, no cascading user deletion. Enforced today at the DB level via `ON DELETE RESTRICT` (Phase 0).
- **"ניהול תפקידים והרשאות" is separate from "ניהול הרשאות משתמשים"** (`electionDay.manageUsers`) - two independent permissions.
- Role fields: name, description, **scope** (תחום עבודה: "כל אנשי הקשר" / "רק המוקצים לי" today, modeled as `scope_type` + reserved `scope_value` so a future dimension, e.g. geographic, is additive, not breaking). "Scope" as a word is never shown in the UI.
- "Clone role" is a required capability.
- Editing an existing user's role is out of scope (stays delete + recreate).
- **Core principle**: the system only knows permissions. `manager`/`operations`/`voting`/any future role are just named permission bundles - there is no "role type" concept in code.
- `legacy_role_key` was a temporary migration-bookkeeping anchor only (removed entirely in Phase 3, see below) - it never participated in any permission/scope decision itself, and was never shown in any UI or touched by role editing while it existed.
- Every migration wrapped in explicit `begin;`/`commit;` (the Supabase CLI pipelines a file's statements, it does not implicitly wrap them in a transaction).
- Rollout was 4 independent, individually testable/deployable/rollback-able phases - no big-bang cutover. All 4 are now shipped.

## Continuation point

**The Dynamic Roles & Permissions initiative (Phases 0-3) is closed** - all 4 phases shipped, deployed, and live-verified in production with zero unresolved regressions, as of 2026-08-06 (commit `2e8191c`). **Security Phases 1-3 (legacy RPC retirement) + Production Rollout is also closed**, as of 2026-08-20 (commit `20946c0`). See both sections above for the full record of each.

**As of this file's 2026-08-20 update, there is no in-flight initiative.** HEAD (`98fde6c`) is pushed and deployed; Production is fully synced with `master` (bundle-hash confirmed); the file-management UI fix and the persistent-reminder feature both closed clean. `git status` shows only the same 16 pre-existing dirty scripts documented above, plus this documentation update itself pending commit - no other uncommitted work.

**Standing OPEN items for whoever picks this up next** (none blocking, none urgent):

1. **Reminder History Backfill Portability Debt** - open, carried forward from an earlier checkpoint; not re-investigated or elaborated by this documentation pass (avoiding inventing detail this update wasn't briefed on).
2. **Pre-existing custom button-color/Tailwind-cascade issue** in the contact modal and both new UI features (call/reschedule/close-reminder buttons render primary/purple instead of green/orange - `cn()` has no Tailwind-merge conflict resolution, see the "File Management UI fix + Persistent Reminders" section above for the mechanism) - cosmetic, confirmed pre-existing, deliberately not fixed as part of either feature above.
3. **Dashboard tiles becoming clickable** is an explicitly future, separate feature - not implemented, not started.
4. `task-plan.md`'s M6 "Polish & ship" checklist items (micro-interactions, a systematic mobile/RTL/lighthouse audit, README+screenshots) remain genuinely open.
5. `task-plan.md`'s P2 "Real backend" items (Postgres schema for voters/activists/classifications, `MockApi`→`SupabaseApi` swap) remain open - only Election Day's own data has moved to Supabase. **Unrelated to and unaffected by the Election Day Security Phases 1-3 rollout above**: Election Day's Supabase backend and the core voter/activist/classification data model are separate, disjoint parts of the app - `src/services/api/index.ts`'s own header comment confirms `listVoters`/`listActivists`/`classifyVoter`/dashboard/import still route to `MockApi` (localStorage), unchanged.
6. The Vercel CLI needs a fresh interactive login for manual convenience commands (`vercel inspect`, etc.) - the project owner's action, not something to script around. **Confirmed non-blocking, not a deployment gate**: every Production deploy and live-bundle verification across this entire documentation-checkpoint's work succeeded via `git push` + Vercel's GitHub auto-deploy integration alone, with zero Vercel CLI involvement - this is optional local tooling/account hygiene, not something anything in this project actually depends on.

**Recommended next step**: none of the items above were assigned or approved as the next piece of work as of this update - check with whoever's driving before starting on any of them. If a next step is wanted purely from a hygiene standpoint, item 1 (Reminder History Backfill Portability Debt) is the only one already named as a specific, scoped standing item rather than an open-ended checklist category.
