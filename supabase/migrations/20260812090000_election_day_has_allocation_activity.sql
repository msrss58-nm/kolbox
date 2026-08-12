-- Coordinator Allocation Management - Phase 2 (import safety), step 1/2.
-- A small, locked-down boolean helper: "has any allocation-management
-- business action ever run?" Used by the next migration's import guard to
-- block a ride-list re-import once real allocation activity has started -
-- an import at that point would silently invalidate every recorded
-- initial_allocation/rebalance/coordinator_end operation's meaning (voters
-- the operations reference could vanish out from under them).
--
-- SECURITY DEFINER (not INVOKER): election_day_coordinator_operations has
-- RLS enabled with ZERO client policies (see the Phase 1 table migration,
-- 20260811100200) - a security invoker function would see zero rows for
-- anon/authenticated regardless of the real data, always returning false
-- and defeating the guard entirely. SECURITY DEFINER runs as the function
-- owner (bypasses RLS), same reasoning as every other DEFINER function in
-- this project that reads a locked-down table (e.g.
-- election_day_list_roles - see 20260805190000). `set search_path = ''`
-- with fully schema-qualified references is the standard hardening against
-- search_path-hijacking of SECURITY DEFINER functions, matching every other
-- DEFINER function here. STABLE: read-only within one statement, no side
-- effects, safe for the planner to fold.
--
-- Deliberately minimal: no parameters, no mutation, returns only a boolean -
-- never exposes a row, a count, or any column from
-- election_day_coordinator_operations. A caller learns only "activity has
-- started: yes/no", nothing about who/what/when.
begin;

create or replace function public.election_day_has_allocation_activity()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.election_day_coordinator_operations
  );
$$;

comment on function public.election_day_has_allocation_activity() is
  'Coordinator Allocation Management: true once at least one election_day_coordinator_operations row exists (initial_allocation / rebalance / coordinator_end has run). SECURITY DEFINER - election_day_coordinator_operations has no client SELECT policy, so an invoker-rights read would always see zero rows. Returns a boolean only - never exposes operation rows/counts/identities. Used by election_day_import_voters (see the next migration) to block a destructive re-import once allocation activity has started.';

revoke all on function public.election_day_has_allocation_activity() from public, anon, authenticated;
grant execute on function public.election_day_has_allocation_activity() to anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual - safe only if election_day_import_voters' guard, added in
-- the next migration, is rolled back first; otherwise the import RPC would
-- call a now-missing function):
--
--   begin;
--   drop function if exists public.election_day_has_allocation_activity();
--   commit;
-- ============================================================================
