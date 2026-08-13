-- Coordinator Allocation Management - Phase 3 (RPC core), final concurrency
-- hardening: closes the race between election_day_import_voters and the 3
-- business allocation RPCs (election_day_apply_initial_allocation,
-- election_day_rebalance_assignments, election_day_end_coordinator_activity
-- - see 20260813100100_election_day_coordinator_allocation_rpcs.sql).
--
-- The problem this closes: election_day_import_voters' existing guard
-- (added in Phase 2, 20260812090100_election_day_import_voters_allocation_guard.sql)
-- checks election_day_has_allocation_activity() and only then
-- deletes/re-inserts.
-- But that check and the delete/insert that follows it were not
-- transactionally isolated from a CONCURRENT business RPC's own
-- transaction - an import could read has_allocation_activity() = false (no
-- operation committed yet), then a business allocation could start,
-- operate, and commit, and only after that could the import's own
-- delete/insert run - silently wiping out voters (and the coordinator
-- assignments/history that already referenced them) that a just-committed
-- operation had just acted on. Two PostgreSQL transactions each individually
-- consistent can still interleave this way under the default read committed
-- isolation level with no shared lock between them.
--
-- The fix: election_day_import_voters now acquires the exact same
-- transaction-level advisory lock as the 3 business RPCs -
-- pg_catalog.pg_advisory_xact_lock(hashtext('election_day_voter_allocation_mutation')::bigint)
-- - as literally its first statement, before even calling
-- election_day_has_allocation_activity(). The lock is released
-- automatically at this transaction's own commit or rollback. Because every
-- one of the 4 mutation paths (this function + the 3 business RPCs) now
-- takes the same lock before doing anything else, they can never have
-- overlapping critical sections: whichever call reaches the lock first runs
-- to completion (commit or rollback) before the other's guard check or
-- business read even begins. See
-- 20260813100100_election_day_coordinator_allocation_rpcs.sql's header
-- comment for the full design and the reasoning for also serializing the 3
-- business RPCs against each other with this same lock.
--
-- Phase 2's migration (20260812090100) is already committed and is NOT
-- edited here - this is a new migration, per this project's standing rule
-- against editing already-applied/committed migrations.
--
-- Everything else about this function is byte-for-byte unchanged from the
-- version applied in 20260812090100_election_day_import_voters_allocation_guard.sql:
-- identical signature (election_day_import_voters(jsonb)), identical
-- SECURITY INVOKER, identical `set search_path = ''`, identical
-- has_allocation_activity() guard (unchanged, not touched), identical
-- `where true` delete guard, identical insert/select column list, identical
-- integer row-count return contract, identical grants. The only change: one
-- new `perform pg_advisory_xact_lock(...)` statement, first in the function
-- body.
begin;

create or replace function public.election_day_import_voters(p_voters jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  -- Global Election Day import/allocation mutation lock - see this
  -- migration's header comment. Must be acquired before the
  -- has_allocation_activity() guard below (and therefore before any
  -- delete/insert) so a concurrent business allocation RPC's own commit is
  -- always fully visible to this guard check, never interleaved with it.
  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_voter_allocation_mutation')::bigint);

  if public.election_day_has_allocation_activity() then
    raise exception 'ALLOCATION_ACTIVITY_STARTED';
  end if;

  delete from public.election_day_ride_status_events where true;
  delete from public.election_day_voters where true;

  insert into public.election_day_voters
    (masad, first_name, last_name, street, house_number, city, phone, coordinator)
  select
    coalesce(x.masad, ''),
    x.first_name,
    x.last_name,
    coalesce(x.street, ''),
    coalesce(x.house_number, 0),
    coalesce(x.city, ''),
    x.phone,
    x.coordinator
  from jsonb_to_recordset(p_voters) as x(
    masad text,
    first_name text,
    last_name text,
    street text,
    house_number integer,
    city text,
    phone text,
    coordinator text
  );

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.election_day_import_voters(jsonb) is
  'Atomically replaces the entire ride-list (see election_day_atomic_import / election_day_atomic_import_where_fix). Blocked entirely (RAISE EXCEPTION ALLOCATION_ACTIVITY_STARTED, before any delete/insert) once election_day_has_allocation_activity() is true - a re-import after real allocation activity has started would invalidate recorded operation history. Acquires the global election_day_voter_allocation_mutation advisory lock as its first statement, before even checking that guard, so this call and the 3 business allocation RPCs (initial allocation / rebalance / coordinator end) can never have overlapping critical sections - closes a race where a concurrent business operation could commit voter/coordinator changes between this guard check and this function''s own delete/insert. coordinator may be null on any row (masad/street/city still default missing values to ''; coordinator does not, by design - see election_day_coordinators_table.sql).';

-- Grants persist across `create or replace function` (same signature), but
-- re-stated here for the same reason as every prior migration touching this
-- function.
revoke all on function public.election_day_import_voters(jsonb) from public, anon, authenticated;
grant execute on function public.election_day_import_voters(jsonb) to anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual - restores the pre-this-migration function body, with no
-- advisory lock - only meaningful if you also want to accept reopening the
-- race this migration closes):
--
--   begin;
--   create or replace function public.election_day_import_voters(p_voters jsonb)
--   returns integer
--   language plpgsql
--   security invoker
--   set search_path = ''
--   as $$
--   declare
--     v_count integer;
--   begin
--     if public.election_day_has_allocation_activity() then
--       raise exception 'ALLOCATION_ACTIVITY_STARTED';
--     end if;
--
--     delete from public.election_day_ride_status_events where true;
--     delete from public.election_day_voters where true;
--
--     insert into public.election_day_voters
--       (masad, first_name, last_name, street, house_number, city, phone, coordinator)
--     select
--       coalesce(x.masad, ''),
--       x.first_name,
--       x.last_name,
--       coalesce(x.street, ''),
--       coalesce(x.house_number, 0),
--       coalesce(x.city, ''),
--       x.phone,
--       x.coordinator
--     from jsonb_to_recordset(p_voters) as x(
--       masad text,
--       first_name text,
--       last_name text,
--       street text,
--       house_number integer,
--       city text,
--       phone text,
--       coordinator text
--     );
--
--     get diagnostics v_count = row_count;
--     return v_count;
--   end;
--   $$;
--   revoke all on function public.election_day_import_voters(jsonb) from public, anon, authenticated;
--   grant execute on function public.election_day_import_voters(jsonb) to anon, authenticated;
--   commit;
-- ============================================================================
