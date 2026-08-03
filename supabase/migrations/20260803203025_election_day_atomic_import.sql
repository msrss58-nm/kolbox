-- A ride-list re-import previously ran as 3 separate REST calls from the
-- client (delete ride_status_events, delete voters, insert new voters) -
-- not wrapped in a single transaction. If the browser tab closed, the
-- network dropped, or the insert failed partway through (e.g. a malformed
-- row) between the deletes and the insert completing, the live table would
-- be left permanently empty - a real data-loss window on the single
-- highest-stakes write in the app, discovered during a production-readiness
-- audit (not previously exercised because earlier testing used small
-- synthetic files that always succeeded in one round trip).
--
-- A Postgres function body is one implicit transaction: if any statement
-- inside raises, every earlier statement in the same call rolls back too.
-- Wrapping delete+delete+insert in a single function call makes the whole
-- import atomic - it either fully replaces the ride-list, or leaves the
-- previous data completely untouched, never a half-deleted table.
--
-- `security invoker` (the default - stated explicitly for clarity) because
-- election_day_voters/election_day_ride_status_events already carry
-- permissive `USING (true)` RLS policies for anon+authenticated (see
-- election_day_core_rls migration) - this function doesn't need or want
-- elevated privileges, it just does in one round trip what the client was
-- already allowed to do in three.
create or replace function public.election_day_import_voters(p_voters jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.election_day_ride_status_events;
  delete from public.election_day_voters;

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

revoke all on function public.election_day_import_voters(jsonb) from public;
grant execute on function public.election_day_import_voters(jsonb) to anon, authenticated;

-- ============================================================================
-- ROLLBACK (manual):
--
--   drop function if exists public.election_day_import_voters(jsonb);
-- ============================================================================
