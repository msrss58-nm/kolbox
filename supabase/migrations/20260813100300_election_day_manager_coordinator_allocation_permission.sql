-- Coordinator Allocation Management - Phase 4.1 (manager permission
-- backfill only, hybrid-safe revision). Grants the built-in מנהל (manager)
-- role the 'electionDay.manageCoordinatorAllocation' permission Phase 4
-- already added to the frontend catalog (src/permissions/types.ts,
-- src/permissions/permissionsMap.ts) and Phase 1 already added to the
-- DB-side write-path allowlist (election_day_is_valid_permission - see
-- 20260811100400_election_day_valid_permission_coordinator_allocation.sql,
-- not touched again here). Neither of those additions, by itself, grants
-- this permission to any persisted role - that's exactly this migration's
-- one job, and its only job. No other role (operations/"משתמש", voting/
-- "נציג קלפי", or any custom/dynamic role) is touched.
--
-- ============================================================================
-- WHY THIS REVISION EXISTS - UUID PORTABILITY AUDIT FINDING
-- ============================================================================
-- The first draft of this migration matched the manager role by a single
-- hardcoded id, '6dd2601d-99da-43b4-b4e7-97ad6d007fa8', copied from the one
-- real prior permission backfill in this project's history
-- (20260810120000_election_day_reminder_lifecycle.sql's bottom block,
-- which grants 'voter.viewReminderHistory' to hardcoded live-production
-- מנהל/משתמש role ids the same way). A dedicated audit traced Phase 0's
-- seed insert (20260805181806_election_day_dynamic_roles_phase0.sql, line
-- ~88: `insert into public.election_day_roles (name, description,
-- permissions, scope_type, legacy_role_key) values (...)`) and confirmed
-- the `id` column is NEVER specified in that INSERT - every built-in role's
-- id comes from the table's own `default gen_random_uuid()`. That means a
-- fresh migration replay (a new local dev DB, a CI test database, a
-- disaster-recovery reseed) generates a DIFFERENT random id for מנהל every
-- time, so a single hardcoded id can only ever match the one specific,
-- already-existing database it was captured from - not a fresh install.
--
-- Also confirmed: `legacy_role_key` (a real stable technical key for
-- built-in roles, added in Phase 0) was deliberately and permanently
-- dropped in 20260806150000_election_day_dynamic_roles_phase3.sql (`alter
-- table public.election_day_roles drop column legacy_role_key;`), which
-- runs before this migration in every migration ordering. As of this
-- migration, there is no stable non-UUID technical key left in the schema
-- for a built-in role - by explicit design, every role (built-in or
-- custom) is "a fully ordinary, editable/renameable/deletable row" (Phase
-- 0's own comment). Reintroducing such a key is a schema change, out of
-- scope for this data-only migration and not attempted here.
--
-- Resolution approved: a HYBRID lookup, tried in this exact order, with no
-- weaker fallback than either path below - if neither resolves unambiguously,
-- this migration raises and aborts rather than guessing.
--
--   PATH A - known Production identity. If a role with id
--   '6dd2601d-99da-43b4-b4e7-97ad6d007fa8' exists, use it, unconditionally -
--   no name check (names are editable), no further verification. This is
--   the exact id previously confirmed live against the real Production
--   database (see the prior draft's own comment / this phase's audit
--   report) - the correct target for the one, already-existing database
--   this migration is actually meant to reach.
--
--   PATH B - fresh-replay-safe fallback, used ONLY when Path A's id is not
--   found. Resolves the manager role by proving the ENTIRE
--   election_day_roles table exactly matches Phase 0's untouched 3-row
--   seed shape - never by name, never by permission-set alone on a single
--   candidate row in isolation. Specifically requires ALL of:
--     1. Exactly 3 rows total in election_day_roles (no custom/dynamic
--        roles have been added - proves nothing else could be mistaken for
--        a seed row, and rules out a deleted-then-differently-recreated
--        table with an unrelated row count).
--     2. Exactly one row has scope_type = 'all' AND its permissions array is
--        in one of exactly two allowed states relative to the 22-element
--        array Phase 0's seed INSERT gives מנהל (copied byte-for-byte from
--        that migration below): State A - exactly those 22 permissions and
--        nothing else, OR State B - exactly those 22 permissions PLUS
--        exactly 'electionDay.manageCoordinatorAllocation' and nothing
--        else. State B exists so this migration's own prior successful run
--        (which appends that one permission to the resolved row) doesn't
--        break its own re-resolution on a second run - see IDEMPOTENCY
--        BUG FIX below for why a naive set-equality-to-22-only check was
--        not actually idempotent, and why plain `@>`/`<@` containment
--        alone is not sufficient to rule out duplicate array entries
--        either (both operators treat an array as a set, so they cannot
--        by themselves distinguish "22 distinct elements" from "21
--        distinct elements plus one repeated" at the same @>/<@ outcome) -
--        an explicit distinct-element-count check closes that gap.
--     3. A row exists whose permissions array is exactly (no more, no
--        less, no duplicates) the 13-element משתמש seed set, scope_type =
--        'assigned_to_me'.
--     4. A row exists whose permissions array is exactly (no more, no
--        less, no duplicates) the 5-element נציג קלפי seed set, scope_type
--        = 'assigned_to_me'.
--   Only when ALL FOUR hold does this migration trust the single
--   scope='all' candidate from #2 as the manager row. Deliberately does
--   NOT use `name = 'מנהל'` anywhere in this proof - a role can be renamed
--   via the Role Management screen (election_day_update_role never
--   restricts editing a built-in role's name), so name is not part of what
--   "unambiguously fresh" means here; a renamed-but-otherwise-untouched
--   manager row still resolves correctly under this signature (it never
--   needed the name to begin with), while an actually-ambiguous/modified
--   database (any extra role, any permission-set drift, more than one
--   scope='all' candidate, any duplicate array entry) correctly fails
--   closed instead of guessing.
--
-- ============================================================================
-- IDEMPOTENCY BUG FIX (this revision)
-- ============================================================================
-- The prior revision's Path B manager condition required the candidate
-- row's permissions to be set-EQUAL to the 22-element baseline only (State
-- A exclusively). That is correct on a pristine fresh-replay database, but
-- after this migration's own first successful run via Path B, the resolved
-- manager row has 23 permissions (the 22 baseline plus the newly-appended
-- 'electionDay.manageCoordinatorAllocation') - so a second run, still on a
-- database where the known Production id doesn't exist, would find ZERO
-- rows matching the old 22-only condition (the row that used to match now
-- has an extra element `<@` rejects), `v_manager_candidates` would be 0,
-- and the migration would incorrectly raise
-- ELECTION_DAY_MANAGER_ROLE_NOT_IDENTIFIABLE on its own successful prior
-- output - not actually idempotent. Fixed by accepting State A OR State B
-- (see point 2 above) as both being valid, expected outcomes of this same
-- migration - the only two states a genuinely-fresh-seeded manager row can
-- ever be in before vs. after this migration's own append.
--
-- Separately, `@>`/`<@` alone cannot prove the array has no duplicate
-- entries (Postgres array containment operators compare arrays as sets,
-- ignoring both order and repetition) - so a candidate row with, say, one
-- baseline permission listed twice (23 elements, only 22 distinct) would
-- satisfy the old State-A-shaped `@>`/`<@` pair by coincidence at the same
-- length a genuine State-B row would have. Every containment check below
-- is therefore paired with an explicit `array_length(...) = (select
-- count(distinct p) from unnest(...) as p)` no-duplicates gate before
-- branching on which state (or, for operations/voting, the one single
-- valid state) the array represents.
--
-- If NEITHER path resolves to exactly one row:
-- raises ELECTION_DAY_MANAGER_ROLE_NOT_IDENTIFIABLE and aborts the whole
-- migration (transactional - begin;/commit; below) - never picks a first
-- match, never falls back to name-only or permission-only matching, never
-- updates more than one row, never silently succeeds while leaving the
-- system without the permission on any real manager role.
--
-- Existing, separate technical debt (not fixed here, out of this
-- migration's scope): 20260810120000's own 'voter.viewReminderHistory'
-- backfill has the exact same single-hardcoded-id limitation this
-- migration's Path A also has, and is therefore very likely NOT
-- fresh-replay portable either (same reasoning: fresh replay generates
-- different role ids, so that migration's `update ... where id in (...)`
-- would silently match zero rows and successfully do nothing on a fresh
-- database) - flagged for a future, separate fix, not addressed in this
-- Phase 4.1 change.
--
-- Idempotency (both paths): identical append mechanism to the precedent -
-- `array_append` gated by `and not (permission = any(permissions))`. Once
-- v_manager_id is resolved (by either path), a second run of this migration
-- resolves the SAME id again (Path A: the known id still exists and is
-- unconditionally reused; Path B: the fresh-seed signature now explicitly
-- accepts State A OR State B - see IDEMPOTENCY BUG FIX above - so granting
-- the one new permission to the manager row on the first run does not
-- break its own re-resolution on the second), the UPDATE's guard then
-- matches zero rows (permission already present), and the post-update
-- assertion still passes. No duplicate permission entry, no re-resolution
-- ambiguity, no error, on any number of re-runs.
--
-- No schema change. No RLS change. No RPC change. No seed-file
-- (builtInRoleSeed.ts) change - that fixture stays frozen to Phase 0's
-- literal migration text for smoke-role-seed-parity.ts's own parity check,
-- unrelated to what any live persisted role actually holds. No frontend
-- change of any kind. No edit to any already-committed migration (Phase
-- 0/1/2/3/reminder-lifecycle/etc. are all untouched) - only this one,
-- still-uncommitted file is modified.
begin;

do $$
declare
  v_known_production_manager_id constant uuid := '6dd2601d-99da-43b4-b4e7-97ad6d007fa8';
  v_permission constant text := 'electionDay.manageCoordinatorAllocation';
  v_manager_id uuid;
  v_total_roles integer;
  v_manager_candidates integer;
  v_operations_seed_present boolean;
  v_voting_seed_present boolean;
  v_has_permission_after boolean;
  -- Exact Phase 0 fresh-seed permission arrays - copied byte-for-byte from
  -- 20260805181806_election_day_dynamic_roles_phase0.sql's insert (that
  -- migration is already committed/applied and is NOT edited here). Order
  -- is preserved for readability only - the comparison below uses
  -- order-independent set-equality (@>/<@), never array equality (=).
  v_manager_seed_permissions constant text[] := array[
    'voter.markVoted', 'voter.manageReminder', 'voter.manageRide', 'voter.editPhone', 'voter.editNotes',
    'electionDay.import', 'electionDay.clearData', 'electionDay.export', 'electionDay.manageSettings',
    'electionDay.manageUsers', 'electionDay.manageRideCoordinators',
    'app.accessFullNavigation',
    'voter.viewName', 'voter.viewAddress', 'voter.viewPhone', 'voter.viewMasad', 'voter.viewCoordinator',
    'voter.viewNotes', 'voter.viewReminderStatus', 'voter.viewRideStatus', 'voter.viewVotedStatus',
    'electionDay.manageRolesAndPermissions'
  ];
  v_operations_seed_permissions constant text[] := array[
    'voter.manageReminder', 'voter.manageRide', 'voter.editPhone', 'voter.editNotes',
    'voter.viewName', 'voter.viewAddress', 'voter.viewPhone', 'voter.viewMasad', 'voter.viewCoordinator',
    'voter.viewNotes', 'voter.viewReminderStatus', 'voter.viewRideStatus', 'voter.viewVotedStatus'
  ];
  v_voting_seed_permissions constant text[] := array[
    'voter.markVoted', 'voter.viewName', 'voter.viewAddress', 'voter.viewPhone', 'voter.viewVotedStatus'
  ];
begin
  -- PATH A - known Production identity, tried first, unconditionally
  -- trusted if found (no name check, no further verification, no other
  -- fallback attempted).
  if exists (
    select 1 from public.election_day_roles where id = v_known_production_manager_id
  ) then
    v_manager_id := v_known_production_manager_id;
  else
    -- PATH B - fresh-replay-safe fallback. Requires the ENTIRE built-in
    -- role set to exactly match Phase 0's untouched seed shape - never a
    -- single candidate row judged in isolation. Every array check below
    -- pairs `@>`/`<@` (set-membership, order-independent) with an explicit
    -- no-duplicates gate (`array_length(...) = count(distinct unnested
    -- element)`) - containment alone cannot tell "N distinct elements"
    -- apart from "fewer distinct elements plus a repeat", so it is never
    -- used by itself here.
    select count(*) into v_total_roles from public.election_day_roles;

    -- Manager candidate: accepts State A (exactly the 22 baseline
    -- permissions) OR State B (exactly the 22 baseline permissions plus
    -- exactly the one new permission this migration itself appends) - see
    -- IDEMPOTENCY BUG FIX above. No other permission-count/content
    -- combination matches either branch.
    select count(*) into v_manager_candidates
    from public.election_day_roles
    where scope_type = 'all'
      and permissions @> v_manager_seed_permissions
      and array_length(permissions, 1) = (
        select count(distinct p) from unnest(permissions) as p
      )
      and (
        -- State A: exactly the 22 baseline permissions, nothing more.
        (
          array_length(permissions, 1) = array_length(v_manager_seed_permissions, 1)
          and permissions <@ v_manager_seed_permissions
        )
        or
        -- State B: exactly the 22 baseline permissions plus exactly this
        -- migration's own permission, nothing more. `<@ (baseline ||
        -- v_permission)` combined with the no-duplicates gate above and
        -- the distinct count being one more than baseline's own length
        -- forces the one extra distinct element to be v_permission
        -- specifically - no other single extra permission can satisfy
        -- both this containment and the length arithmetic simultaneously.
        (
          array_length(permissions, 1) = array_length(v_manager_seed_permissions, 1) + 1
          and permissions <@ (v_manager_seed_permissions || v_permission)
        )
      );

    select exists (
      select 1 from public.election_day_roles
      where scope_type = 'assigned_to_me'
        and permissions @> v_operations_seed_permissions
        and permissions <@ v_operations_seed_permissions
        and array_length(permissions, 1) = array_length(v_operations_seed_permissions, 1)
    ) into v_operations_seed_present;

    select exists (
      select 1 from public.election_day_roles
      where scope_type = 'assigned_to_me'
        and permissions @> v_voting_seed_permissions
        and permissions <@ v_voting_seed_permissions
        and array_length(permissions, 1) = array_length(v_voting_seed_permissions, 1)
    ) into v_voting_seed_present;

    if v_total_roles = 3
       and v_manager_candidates = 1
       and v_operations_seed_present
       and v_voting_seed_present
    then
      select id into v_manager_id
      from public.election_day_roles
      where scope_type = 'all'
        and permissions @> v_manager_seed_permissions
        and array_length(permissions, 1) = (
          select count(distinct p) from unnest(permissions) as p
        )
        and (
          (
            array_length(permissions, 1) = array_length(v_manager_seed_permissions, 1)
            and permissions <@ v_manager_seed_permissions
          )
          or
          (
            array_length(permissions, 1) = array_length(v_manager_seed_permissions, 1) + 1
            and permissions <@ (v_manager_seed_permissions || v_permission)
          )
        );
    end if;
  end if;

  if v_manager_id is null then
    raise exception 'ELECTION_DAY_MANAGER_ROLE_NOT_IDENTIFIABLE: neither the known Production manager id (%) exists, nor does election_day_roles unambiguously match the fresh Phase 0 seed baseline (exactly 3 roles: one scope=all/22-permission manager candidate + the exact operations + voting seed permission sets) - refusing to guess', v_known_production_manager_id;
  end if;

  update public.election_day_roles
  set permissions = array_append(permissions, v_permission)
  where id = v_manager_id
    and not (v_permission = any(permissions));

  select (v_permission = any(permissions))
    into v_has_permission_after
  from public.election_day_roles
  where id = v_manager_id;

  if v_has_permission_after is not true then
    raise exception 'ELECTION_DAY_MANAGER_PERMISSION_BACKFILL_FAILED: resolved election_day_roles.id = % still missing % after update', v_manager_id, v_permission;
  end if;
end $$ language plpgsql;

commit;

-- ============================================================================
-- ROLLBACK (manual - targets the known Production id only; a fresh-replay
-- database resolved via Path B would need its own actual id substituted
-- here, since that id is generated at seed time and not knowable in
-- advance):
--
--   begin;
--   update public.election_day_roles
--   set permissions = array_remove(permissions, 'electionDay.manageCoordinatorAllocation')
--   where id = '6dd2601d-99da-43b4-b4e7-97ad6d007fa8';
--   commit;
-- ============================================================================
