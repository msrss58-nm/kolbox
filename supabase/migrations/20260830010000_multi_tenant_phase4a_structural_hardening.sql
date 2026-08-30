-- Multi-Tenant Phase 4A: structural hardening (Contract closure of the
-- original Phase 3 "workspace_id NOT NULL" step, plus 2 small standalone
-- fixes). Strictly additive/tightening - no RLS change, no voter-mutation
-- RPC change, no frontend change, no election_day_settings change (see
-- root-cause note below - it needs its own, separate, later conversion).
-- See CURRENT_STATUS.md for the full Phase 4 scoping report this migration
-- implements the first slice of.
--
-- ============================================================================
-- FRESH-DB ROOT CAUSE
-- ============================================================================
-- 3 of the 12 workspace_id-bearing tables carry migration-time seed/default
-- rows written BEFORE Multi-Tenant existed as a concept - weeks before
-- election_workspaces (20260823010000) was even created:
--   - election_day_settings: 1 singleton row (20260803174712).
--   - election_day_roles: 3 built-in roles (20260805181806).
--   - election_day_not_voting_reasons: 6 starter reasons (20260806160000).
-- Production's real copies were attributed to its one real workspace by the
-- Phase 2 historical-backfill RPC (a one-time DATA operation, never a
-- migration, since dropped). A fresh `db reset` never runs that backfill,
-- so these 3 seeds stay permanently NULL-workspace on any new install.
-- Historical migrations are not edited; no workspace is fabricated/guessed
-- (a fresh install genuinely has zero election_workspaces rows to guess
-- from).
--
-- election_day_settings is excluded from this migration entirely (not just
-- from the NOT NULL set) - it is a genuine Postgres singleton (`id boolean
-- primary key default true`) and getElectionDayDeadline/
-- setElectionDayDeadline (supabaseElectionDayApi.ts) both require the row
-- via `.eq("id", true).single()` - deleting it would break the countdown
-- feature outright. Converting it to a real per-workspace design (new uuid
-- PK, workspace_id unique not null, app-layer query changes) is separate,
-- larger, not-yet-designed work - explicitly out of this migration's scope.
--
-- election_day_roles / election_day_not_voting_reasons ARE cleaned up here:
-- re-reading election_day_list_roles_v3 confirms it filters strictly
-- `workspace_id = <session's own workspace>` with no unscoped fallback, so
-- a NULL-workspace role is already permanently unreachable through the live
-- architecture - these rows are orphaned, not global templates. Neither
-- table is ever read via a `.single()`/`.eq()` call requiring a row to
-- exist (grep of supabaseElectionDayApi.ts confirms both go through RPCs
-- that handle an empty result set fine), so removing orphans is safe for
-- app behavior.
--
-- ============================================================================
-- DETERMINISTIC IDENTIFICATION (not a count threshold) - traced through
-- every historical mutation to these 2 tables' identity columns, not
-- assumed from the original seed text alone:
-- ============================================================================
-- election_day_roles.name is DB-enforced UNIQUE (20260805181806's own
-- CREATE TABLE) - combined with workspace_id IS NULL this is already an
-- airtight fingerprint; scope_type is included as cheap extra corroboration.
-- permissions is deliberately NOT part of the fingerprint - it has been
-- mutated by at least 3 separate, unrelated, already-applied `array_append`
-- migrations since the original seed (20260810120000, 20260811100400,
-- 20260813100300, all idempotent/conditional appends of individual
-- permission strings) - reconstructing its exact current literal value by
-- hand would itself be a guess, which this fingerprint must not be.
-- name IS mutated once, traced precisely: 20260823000000 renamed the
-- built-in "משתמש" role to "טלפן/ית" (id/permissions/scope_type/scope_value
-- untouched by that migration, per its own header). The 3 CURRENT
-- (name, scope_type) pairs used below reflect that rename, not the
-- original Phase 0 seed text.
--
-- election_day_not_voting_reasons.name is DB-enforced UNIQUE
-- (20260806160000's own CREATE TABLE) and, unlike roles, has never been
-- renamed by any migration (checked exhaustively) - name alone is already
-- airtight; sort_order is included as corroboration.
--
-- Fail-closed: if any NULL-workspace row in either table does NOT match
-- one of these known fingerprints, this migration RAISEs and refuses to
-- proceed - it never deletes an unrecognized row, and never silently
-- leaves one behind for the later SET NOT NULL to fail on unexplained.
--
-- ============================================================================
-- REFERENCE SAFETY - proven, not assumed, before any DELETE
-- ============================================================================
-- pg_constraint confirms exactly 2 FKs reference these tables, both
-- ON DELETE RESTRICT: election_day_permission_users.role_id ->
-- election_day_roles(id), and election_day_voters.not_voting_reason_id ->
-- election_day_not_voting_reasons(id). RESTRICT would itself reject a
-- referenced row's deletion, but this migration checks explicitly and
-- RAISEs with a clear message BEFORE attempting the DELETE, rather than
-- relying on a raw FK-violation error - on Production this is moot (both
-- tables already have 0 NULL rows, so 0 candidates are ever considered);
-- on a fresh install these referencing tables are still empty at this
-- point (nothing has created a PermissionUser or voter yet), so 0
-- references are expected there too, but the check runs unconditionally.
--
-- ============================================================================
-- Preflight (read-only, against linked Production, immediately before
-- authoring this migration):
-- ============================================================================
--   - All 12 workspace_id-bearing tables: 0 NULL workspace_id rows
--     (voters 1420, reminder_events 34, coordinator_operation_items 30,
--     permission_users 8, coordinators 5, roles 5, not_voting_reasons 5,
--     coordinator_operations 3, ride_status_events 4, reauth_proofs 2,
--     settings 1, ride_coordinators 0) - so the DELETEs below are a
--     verified no-op against Production.
--   - election_day_coordinators carries exactly 2 global (non-workspace-
--     scoped) unique indexes: (display_name) WHERE status = 'active', and
--     (linked_assignment_name) WHERE linked_assignment_name IS NOT NULL.
--   - election_day_login(text,text), election_day_reauth(uuid,text),
--     election_day_revoke_reauth_proof(text) all still carry anon+
--     authenticated EXECUTE. election_day_verify_reauth_proof(text)
--     already carries NO anon/authenticated EXECUTE (postgres+service_role
--     only) - included below anyway for explicit, documented parity.
--   - election_day_logout (non-v2) DOES NOT EXIST anywhere in this
--     project's schema or migration history - omitted from this migration.
--   - Source-grep confirmed all 4 real legacy functions below are dead in
--     the live app (useElectionDayReauth's gate() is never invoked by any
--     mutation; verifyPermissionUserLogin/revokeReauthProof have zero real
--     callers beyond interface wiring / an always-null-proof guard).
--
-- login_v2/logout_v2 are NOT touched - separate, live, service_role-only
-- session RPCs (api/election-day/session.ts), unaffected by this migration.
begin;

-- ============================================================================
-- 1. Deterministic, reference-checked removal of orphaned pre-Multi-Tenant
--    seed rows (see design notes above).
-- ============================================================================
do $$
declare
  v_roles_null_total integer;
  v_roles_fingerprint_match integer;
  v_roles_ref_count integer;
  v_reasons_null_total integer;
  v_reasons_fingerprint_match integer;
  v_reasons_ref_count integer;
begin
  -- --- election_day_roles ---
  select count(*) into v_roles_null_total
  from public.election_day_roles
  where workspace_id is null;

  select count(*) into v_roles_fingerprint_match
  from public.election_day_roles
  where workspace_id is null
    and (name, scope_type) in (
      ('מנהל', 'all'),
      ('טלפן/ית', 'assigned_to_me'),
      ('נציג קלפי', 'assigned_to_me')
    );

  if v_roles_null_total <> v_roles_fingerprint_match then
    raise exception 'PHASE4A_UNRECOGNIZED_NULL_ROLE: % NULL-workspace election_day_roles row(s) found, only % match the known pre-Multi-Tenant seed fingerprint (name+scope_type, post-20260823000000-rename). Refusing to guess about the rest.', v_roles_null_total, v_roles_fingerprint_match;
  end if;

  select count(*) into v_roles_ref_count
  from public.election_day_permission_users pu
  join public.election_day_roles r on r.id = pu.role_id
  where r.workspace_id is null
    and (r.name, r.scope_type) in (
      ('מנהל', 'all'),
      ('טלפן/ית', 'assigned_to_me'),
      ('נציג קלפי', 'assigned_to_me')
    );

  if v_roles_ref_count > 0 then
    raise exception 'PHASE4A_SEED_ROLE_REFERENCED: % election_day_permission_users row(s) reference a NULL-workspace seed role via role_id - refusing to delete a role still in use.', v_roles_ref_count;
  end if;

  -- --- election_day_not_voting_reasons ---
  select count(*) into v_reasons_null_total
  from public.election_day_not_voting_reasons
  where workspace_id is null;

  select count(*) into v_reasons_fingerprint_match
  from public.election_day_not_voting_reasons
  where workspace_id is null
    and name in ('אמר שלא יגיע', 'מספר טלפון שגוי', 'לא עונה', 'בחו"ל', 'נפטר', 'עבר עיר');

  if v_reasons_null_total <> v_reasons_fingerprint_match then
    raise exception 'PHASE4A_UNRECOGNIZED_NULL_REASON: % NULL-workspace election_day_not_voting_reasons row(s) found, only % match the known pre-Multi-Tenant seed fingerprint (name). Refusing to guess about the rest.', v_reasons_null_total, v_reasons_fingerprint_match;
  end if;

  select count(*) into v_reasons_ref_count
  from public.election_day_voters v
  join public.election_day_not_voting_reasons r on r.id = v.not_voting_reason_id
  where r.workspace_id is null
    and r.name in ('אמר שלא יגיע', 'מספר טלפון שגוי', 'לא עונה', 'בחו"ל', 'נפטר', 'עבר עיר');

  if v_reasons_ref_count > 0 then
    raise exception 'PHASE4A_SEED_REASON_REFERENCED: % election_day_voters row(s) reference a NULL-workspace seed reason via not_voting_reason_id - refusing to delete a reason still in use.', v_reasons_ref_count;
  end if;
end;
$$;

delete from public.election_day_roles
where workspace_id is null
  and (name, scope_type) in (
    ('מנהל', 'all'),
    ('טלפן/ית', 'assigned_to_me'),
    ('נציג קלפי', 'assigned_to_me')
  );

delete from public.election_day_not_voting_reasons
where workspace_id is null
  and name in ('אמר שלא יגיע', 'מספר טלפון שגוי', 'לא עונה', 'בחו"ל', 'נפטר', 'עבר עיר');

-- ============================================================================
-- 2. workspace_id NOT NULL - 11 of the 12 Phase-1 tables. election_day_
--    settings is deliberately excluded (see root-cause note above). Postgres
--    itself atomically re-validates zero-NULL at ALTER time for every table
--    below; the preflight/cleanup above is corroborating evidence, not a
--    substitute for this check.
-- ============================================================================
alter table public.election_day_voters
  alter column workspace_id set not null;
alter table public.election_day_ride_status_events
  alter column workspace_id set not null;
alter table public.election_day_ride_coordinators
  alter column workspace_id set not null;
alter table public.election_day_permission_users
  alter column workspace_id set not null;
alter table public.election_day_coordinators
  alter column workspace_id set not null;
alter table public.election_day_coordinator_operations
  alter column workspace_id set not null;
alter table public.election_day_coordinator_operation_items
  alter column workspace_id set not null;
alter table public.election_day_roles
  alter column workspace_id set not null;
alter table public.election_day_not_voting_reasons
  alter column workspace_id set not null;
alter table public.election_day_reminder_events
  alter column workspace_id set not null;
alter table public.election_day_reauth_proofs
  alter column workspace_id set not null;

-- ============================================================================
-- 3. Coordinator uniqueness - workspace-scoped, exact same partial
--    predicates as the global indexes they replace.
-- ============================================================================
drop index if exists public.election_day_coordinators_active_display_name_key;
create unique index election_day_coordinators_workspace_active_display_name_key
  on public.election_day_coordinators (workspace_id, display_name)
  where status = 'active';

drop index if exists public.election_day_coordinators_linked_assignment_name_key;
create unique index election_day_coordinators_workspace_linked_assignment_name_key
  on public.election_day_coordinators (workspace_id, linked_assignment_name)
  where linked_assignment_name is not null;

-- ============================================================================
-- 4. Retire dead legacy login/reauth RPCs from anon/authenticated. REVOKE
--    EXECUTE only (matching this project's established retirement
--    precedent, e.g. 20260813130000/20260828010000) - function bodies stay
--    intact, postgres/service_role keep EXECUTE, a single re-GRANT (see
--    ROLLBACK below) restores compatibility if ever needed.
-- ============================================================================
revoke execute on function public.election_day_login(text, text) from anon, authenticated;
revoke execute on function public.election_day_reauth(uuid, text) from anon, authenticated;
revoke execute on function public.election_day_verify_reauth_proof(text) from anon, authenticated;
revoke execute on function public.election_day_revoke_reauth_proof(text) from anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual - copy/paste and run against the remote if this
-- migration needs to be reversed; the orphaned seed rows this migration
-- deletes are NOT restorable by this rollback - they were dead/unreachable
-- pre-Multi-Tenant artifacts, not live data, so this is not a data-loss
-- concern, but re-running this migration a second time will not recreate
-- them either):
--
--   begin;
--   grant execute on function public.election_day_login(text, text) to anon, authenticated;
--   grant execute on function public.election_day_reauth(uuid, text) to anon, authenticated;
--   grant execute on function public.election_day_verify_reauth_proof(text) to anon, authenticated;
--   grant execute on function public.election_day_revoke_reauth_proof(text) to anon, authenticated;
--
--   drop index if exists public.election_day_coordinators_workspace_active_display_name_key;
--   create unique index election_day_coordinators_active_display_name_key
--     on public.election_day_coordinators (display_name)
--     where status = 'active';
--   drop index if exists public.election_day_coordinators_workspace_linked_assignment_name_key;
--   create unique index election_day_coordinators_linked_assignment_name_key
--     on public.election_day_coordinators (linked_assignment_name)
--     where linked_assignment_name is not null;
--
--   alter table public.election_day_reauth_proofs alter column workspace_id drop not null;
--   alter table public.election_day_reminder_events alter column workspace_id drop not null;
--   alter table public.election_day_not_voting_reasons alter column workspace_id drop not null;
--   alter table public.election_day_roles alter column workspace_id drop not null;
--   alter table public.election_day_coordinator_operation_items alter column workspace_id drop not null;
--   alter table public.election_day_coordinator_operations alter column workspace_id drop not null;
--   alter table public.election_day_coordinators alter column workspace_id drop not null;
--   alter table public.election_day_permission_users alter column workspace_id drop not null;
--   alter table public.election_day_ride_coordinators alter column workspace_id drop not null;
--   alter table public.election_day_ride_status_events alter column workspace_id drop not null;
--   alter table public.election_day_voters alter column workspace_id drop not null;
--   commit;
-- ============================================================================
