-- Corrective fix for election_day_import_voters (see
-- election_day_atomic_import migration), found immediately when testing the
-- real re-import: Supabase's hosted Postgres enforces a "DELETE/UPDATE
-- requires a WHERE clause" safety guard (error 21000) - the same reason the
-- client previously had to use `.neq("id", <all-zeros-uuid>)` instead of a
-- plain unfiltered delete. The function's bare `delete from` statements hit
-- this guard and failed immediately - proving the atomicity design itself
-- works exactly as intended (the whole call rolled back, existing data was
-- never touched), it just never got a chance to run. Adding `where true` -
-- functionally identical to no filter, but satisfies the guard the same way
-- the client-side `.neq(...)` idiom did.
create or replace function public.election_day_import_voters(p_voters jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
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

-- Grants persist across `create or replace function` (same signature), but
-- re-stated here so this migration is correct standalone if ever replayed
-- against a fresh database.
revoke all on function public.election_day_import_voters(jsonb) from public;
grant execute on function public.election_day_import_voters(jsonb) to anon, authenticated;

-- ============================================================================
-- ROLLBACK (manual - restores the pre-this-migration function body, which
-- would fail on every call due to the missing WHERE clause - only meaningful
-- paired with rolling back election_day_atomic_import too):
--
--   drop function if exists public.election_day_import_voters(jsonb);
-- ============================================================================
