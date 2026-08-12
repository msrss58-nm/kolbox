-- Coordinator Allocation Management - Phase 2 (import safety), step 2/2.
-- Adds a re-import guard to the existing election_day_import_voters RPC:
-- once real allocation activity has started (any row exists in
-- election_day_coordinator_operations - initial_allocation, rebalance, or
-- coordinator_end, including a coordinator_end that moved 0 voters), a
-- fresh ride-list import is blocked entirely, before any delete/insert runs.
-- A wholesale-replace import at that point would silently invalidate every
-- already-recorded operation's meaning (the voters those operations
-- reference could be deleted out from under them) - there is no
-- merge/upsert import path in V1, and "replace the database after
-- allocation activity" is a deliberately separate, not-yet-built flow.
--
-- Everything else about this function is unchanged from the live version
-- (see 20260803210234_election_day_atomic_import_where_fix.sql, the current
-- definition prior to this migration) - same signature
-- (election_day_import_voters(jsonb)), same SECURITY INVOKER (election_day_
-- voters/election_day_ride_status_events both carry a permissive
-- USING(true) policy already, same as every other existing Election Day
-- RPC on these two tables - no elevated privilege is newly needed here, and
-- this migration deliberately does NOT change that to SECURITY DEFINER),
-- same `set search_path = ''`, same one-function-body-is-one-transaction
-- atomicity, same `where true` delete guard (Supabase's hosted Postgres
-- requires a WHERE clause on DELETE), same insert/select column list, and
-- same integer row-count return contract. The only functional change below
-- the guard itself: `x.coordinator` was already passed straight through
-- with no `coalesce` (unlike masad/street/city, which default missing
-- values to '') - a jsonb `coordinator` field of `null` already parsed as
-- SQL NULL under the previous NOT NULL column constraint (Phase 1 already
-- dropped that constraint - see 20260811100000); no change to this
-- statement was needed for coordinator-null rows to import successfully.
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
  'Atomically replaces the entire ride-list (see election_day_atomic_import / election_day_atomic_import_where_fix). Coordinator Allocation Management Phase 2: now blocked entirely (RAISE EXCEPTION ALLOCATION_ACTIVITY_STARTED, before any delete/insert) once election_day_has_allocation_activity() is true - a re-import after real allocation activity has started would invalidate recorded operation history. coordinator may now be null on any row (masad/street/city still default missing values to ''; coordinator does not, by design - see election_day_coordinators_table.sql).';

-- Grants persist across `create or replace function` (same signature), but
-- re-stated here so this migration is correct standalone if ever replayed
-- against a fresh database - same reasoning as every other migration that
-- touches this function.
revoke all on function public.election_day_import_voters(jsonb) from public, anon, authenticated;
grant execute on function public.election_day_import_voters(jsonb) to anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual - restores the pre-this-migration function body, with no
-- allocation-activity guard - only meaningful if no coordinator_operations
-- row exists yet, otherwise this simply re-opens the exact hazard this
-- migration closes):
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
