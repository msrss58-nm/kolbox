-- Platform Stage 6 - DATABASE suite: aggregate-only cross-workspace read
-- backend (migration 20260913000000). Covers catalog/ACL, authorization
-- (seat, exclusivity, replacement, assignment gate, freshness), aggregate
-- correctness against the dashboard definitions, privacy rules (ACTIVE-only,
-- minimum reportable population, no identifying output columns), determinism,
-- and a Stage 5 regression.
--
-- Run ONLY against the isolated scratch stack (scripts/stage5/mkScratchStack.mjs):
--   docker exec -i supabase_db_kolboxs5 psql -U postgres -v ON_ERROR_STOP=1 < scripts/stage6/db-stage6.sql
--
-- ONE transaction, ROLLED BACK at the end: re-runnable, leaves no rows.
-- Synthetic identities only. Non-zero exit on any failed assertion.

\set ON_ERROR_STOP on
\pset pager off
begin;

create temp table _r (n serial primary key, id text not null, ok boolean not null, detail text);

create function pg_temp.chk(p_id text, p_ok boolean, p_detail text) returns void
language sql as $$ insert into _r (id, ok, detail) values (p_id, coalesce(p_ok, false), p_detail) $$;

create function pg_temp.try_as(p_role text, p_sql text) returns text
language plpgsql as $$
begin
  execute format('set local role %I', p_role);
  execute p_sql;
  reset role;
  return 'OK';
exception when others then
  return sqlstate || ':' || sqlerrm;
end $$;

-- One workspace aggregate as a single comparable text value (as postgres).
create function pg_temp.agg(p_user uuid, p_ws uuid) returns text
language sql as $$
  select concat_ws('|', report_status, contacts_total, voted, follow_up_closed, follow_up_remaining,
                   ride_needed, ride_arranged, ride_completed)
  from public.multi_entity_get_workspace_aggregate(p_user, p_ws)
$$;

-- ---------------------------------------------------------------------------
-- Fixtures (inside the rolled-back transaction)
-- ---------------------------------------------------------------------------
delete from public.multi_entity_assignments;
delete from public.multi_entity_owner;
delete from public.election_owners;
delete from public.election_workspace_pending_owner_access;
delete from public.platform_owners;

insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
  ('61000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','s6-po@stage6.invalid', now(), now()),
  ('61000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','s6-me1@stage6.invalid', now(), now()),
  ('61000000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','s6-me2@stage6.invalid', now(), now()),
  ('61000000-0000-4000-8000-000000000004','00000000-0000-0000-0000-000000000000','authenticated','authenticated','s6-eo@stage6.invalid', now(), now()),
  ('61000000-0000-4000-8000-000000000005','00000000-0000-0000-0000-000000000000','authenticated','authenticated','s6-stranger@stage6.invalid', now(), now());

insert into public.platform_owners (auth_user_id, name, email)
values ('61000000-0000-4000-8000-000000000001', 'S6 Platform Owner', 's6-po@stage6.invalid');

-- a1 BIG (mixed statuses) | a2 same name as a1 (ordering) | b0 exactly 10 |
-- c0 nine | d0 zero | e0 one | f0 ended | f1 ends exactly now() (ended) |
-- f2 ends in 1 s (active) | 99 NOT assigned (big, all voted - leakage probe)
insert into public.election_workspaces (id, name, election_end_at, login_code) values
  ('62000000-0000-4000-8000-0000000000a1', 'S6 Alpha',      now() + interval '10 days', public.election_day_generate_workspace_login_code()),
  ('62000000-0000-4000-8000-0000000000a2', 'S6 Alpha',      now() + interval '10 days', public.election_day_generate_workspace_login_code()),
  ('62000000-0000-4000-8000-0000000000b0', 'S6 Beta',       now() + interval '10 days', public.election_day_generate_workspace_login_code()),
  ('62000000-0000-4000-8000-0000000000c0', 'S6 Gamma',      now() + interval '10 days', public.election_day_generate_workspace_login_code()),
  ('62000000-0000-4000-8000-0000000000d0', 'S6 Delta',      now() + interval '10 days', public.election_day_generate_workspace_login_code()),
  ('62000000-0000-4000-8000-0000000000e0', 'S6 Epsilon',    now() + interval '10 days', public.election_day_generate_workspace_login_code()),
  ('62000000-0000-4000-8000-0000000000f0', 'S6 Zeta',       now() - interval '1 day',   public.election_day_generate_workspace_login_code()),
  ('62000000-0000-4000-8000-0000000000f1', 'S6 Zeta Edge',  now(),                      public.election_day_generate_workspace_login_code()),
  ('62000000-0000-4000-8000-0000000000f2', 'S6 Soon',       now() + interval '1 second', public.election_day_generate_workspace_login_code()),
  ('62000000-0000-4000-8000-000000000099', 'S6 Unassigned', now() + interval '10 days', public.election_day_generate_workspace_login_code());

-- Stage 9: raw-SQL fixture workspaces carry no module entitlement; these
-- aggregate tests are about Election Day workspaces, so grant it explicitly
-- (provisioning and the Stage 9 backfill do the same for real workspaces).
insert into public.election_workspace_modules (workspace_id, module_key)
  select id, 'election_day' from public.election_workspaces
  where id::text like '62000000-0000-4000-8000-%';

insert into public.election_day_not_voting_reasons (id, workspace_id, name, description, is_active, sort_order, requires_follow_up) values
  ('63000000-0000-4000-8000-000000000001', '62000000-0000-4000-8000-0000000000a1', 'S6 closed active',   '', true,  1, false),
  ('63000000-0000-4000-8000-000000000002', '62000000-0000-4000-8000-0000000000a1', 'S6 closed inactive', '', false, 2, false),
  ('63000000-0000-4000-8000-000000000003', '62000000-0000-4000-8000-0000000000a1', 'S6 follow up',       '', true,  3, true),
  ('63000000-0000-4000-8000-000000000004', '62000000-0000-4000-8000-000000000099', 'S6 foreign closed',  '', true,  1, false);

-- BIG a1: 12 contacts. Expected: total 12, voted 3, closed 2, remaining 7,
-- needed 1, arranged 1, completed 3.
insert into public.election_day_voters (workspace_id, first_name, last_name, phone, notes, voted, ride_requested, ride_arranged, ride_completed, not_voting_reason_id) values
  ('62000000-0000-4000-8000-0000000000a1', 'S6', 'c01', '0500000001', 'secret note', true,  true,  true,  true,  null),                                    -- voted, completed
  ('62000000-0000-4000-8000-0000000000a1', 'S6', 'c02', null,         '',            true,  false, false, false, null),                                    -- voted
  ('62000000-0000-4000-8000-0000000000a1', 'S6', 'c03', null,         '',            true,  false, false, false, '63000000-0000-4000-8000-000000000001'),  -- voted wins over a closed reason
  ('62000000-0000-4000-8000-0000000000a1', 'S6', 'c04', null,         '',            false, false, false, false, '63000000-0000-4000-8000-000000000001'),  -- closed
  ('62000000-0000-4000-8000-0000000000a1', 'S6', 'c05', null,         '',            false, false, false, false, '63000000-0000-4000-8000-000000000002'),  -- closed (inactive reason still closes)
  ('62000000-0000-4000-8000-0000000000a1', 'S6', 'c06', null,         '',            false, false, false, false, '63000000-0000-4000-8000-000000000003'),  -- remaining (follow-up reason)
  ('62000000-0000-4000-8000-0000000000a1', 'S6', 'c07', null,         '',            false, true,  false, false, null),                                    -- remaining, needs ride
  ('62000000-0000-4000-8000-0000000000a1', 'S6', 'c08', null,         '',            false, true,  true,  false, null),                                    -- remaining, arranged
  ('62000000-0000-4000-8000-0000000000a1', 'S6', 'c09', null,         '',            false, true,  true,  true,  null),                                    -- remaining, completed
  ('62000000-0000-4000-8000-0000000000a1', 'S6', 'c10', null,         '',            false, false, false, false, '63000000-0000-4000-8000-000000000004'),  -- remaining: FOREIGN-workspace reason never closes
  ('62000000-0000-4000-8000-0000000000a1', 'S6', 'c11', null,         '',            false, false, false, true,  null),                                    -- remaining, completed (completed wins)
  ('62000000-0000-4000-8000-0000000000a1', 'S6', 'c12', null,         '',            false, false, false, false, null);                                    -- remaining

-- a2: 10, all voted. b0: 10, 4 voted. c0: 9. e0: 1 voted. f0: 20. f1: 10. f2: 10 (2 voted). 99: 15 all voted + rides.
insert into public.election_day_voters (workspace_id, first_name, last_name, voted)
  select '62000000-0000-4000-8000-0000000000a2', 'S6', 'a2-' || g, true from generate_series(1, 10) g;
insert into public.election_day_voters (workspace_id, first_name, last_name, voted)
  select '62000000-0000-4000-8000-0000000000b0', 'S6', 'b0-' || g, g <= 4 from generate_series(1, 10) g;
insert into public.election_day_voters (workspace_id, first_name, last_name, voted)
  select '62000000-0000-4000-8000-0000000000c0', 'S6', 'c0-' || g, true from generate_series(1, 9) g;
insert into public.election_day_voters (workspace_id, first_name, last_name, voted)
  values ('62000000-0000-4000-8000-0000000000e0', 'S6', 'e0-1', true);
insert into public.election_day_voters (workspace_id, first_name, last_name, voted)
  select '62000000-0000-4000-8000-0000000000f0', 'S6', 'f0-' || g, true from generate_series(1, 20) g;
insert into public.election_day_voters (workspace_id, first_name, last_name, voted)
  select '62000000-0000-4000-8000-0000000000f1', 'S6', 'f1-' || g, true from generate_series(1, 10) g;
insert into public.election_day_voters (workspace_id, first_name, last_name, voted)
  select '62000000-0000-4000-8000-0000000000f2', 'S6', 'f2-' || g, g <= 2 from generate_series(1, 10) g;
insert into public.election_day_voters (workspace_id, first_name, last_name, voted, ride_requested, ride_arranged, ride_completed)
  select '62000000-0000-4000-8000-000000000099', 'S6', 'x-' || g, true, true, true, true from generate_series(1, 15) g;

insert into public.multi_entity_owner (auth_user_id, name, email)
values ('61000000-0000-4000-8000-000000000002', 'S6 Seat', 's6-me1@stage6.invalid');

insert into public.multi_entity_assignments (workspace_id)
  select id from public.election_workspaces
  where id::text like '62000000-0000-4000-8000-0000000000%' and id <> '62000000-0000-4000-8000-000000000099';

insert into public.election_owners (workspace_id, auth_user_id, name, email)
values ('62000000-0000-4000-8000-0000000000b0', '61000000-0000-4000-8000-000000000004', 'S6 Election Owner', 's6-eo@stage6.invalid');

-- ===========================================================================
-- A. CATALOG / ACL
-- ===========================================================================
do $$
declare
  r record;
  n int := 0;
  expected_result text := 'TABLE(workspace_id uuid, name text, election_end_at timestamp with time zone, assigned_at timestamp with time zone, report_status text, contacts_total integer, voted integer, follow_up_closed integer, follow_up_remaining integer, ride_needed integer, ride_arranged integer, ride_completed integer)';
begin
  for r in
    select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args,
           pg_get_userbyid(p.proowner) as owner, p.prosecdef, p.provolatile::text as vol,
           coalesce(array_to_string(p.proconfig, ','), '') as cfg,
           coalesce(p.proacl::text, '<null>') as acl,
           pg_get_function_result(p.oid) as result
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('multi_entity_compute_workspace_aggregate', 'multi_entity_get_workspace_aggregate',
                        'multi_entity_list_workspace_aggregates')
  loop
    n := n + 1;
    perform pg_temp.chk('A1 ' || r.proname || ' owner/secdef/stable/search_path',
      r.owner = 'postgres' and r.prosecdef and r.vol = 's' and r.cfg = 'search_path=""',
      format('owner=%s secdef=%s vol=%s cfg=%s', r.owner, r.prosecdef, r.vol, r.cfg));
    if r.proname = 'multi_entity_compute_workspace_aggregate' then
      perform pg_temp.chk('A2 ' || r.proname || ' proacl (no role at all)', r.acl = '{postgres=X/postgres}', r.acl);
    else
      perform pg_temp.chk('A2 ' || r.proname || ' proacl (service_role only)',
        r.acl = '{postgres=X/postgres,service_role=X/postgres}', r.acl);
    end if;
    perform pg_temp.chk('A3 ' || r.proname || ' output columns are exactly the aggregate contract',
      r.result = expected_result, r.result);
    perform pg_temp.chk('A3 ' || r.proname || ' output carries no identifying column',
      r.result !~* '(login_code|first_name|last_name|phone|street|house|city|masad|notes|coordinator|email|auth_user|reason_id|contact_id)',
      'scanned');
  end loop;
  perform pg_temp.chk('A0 exactly 3 Stage 6 functions, one overload each', n = 3, 'found ' || n);

  perform pg_temp.chk('A4 Stage 5 function ACLs unchanged',
    (select string_agg(proname || '=' || coalesce(proacl::text, ''), ',' order by proname)
       from pg_proc where pronamespace = 'public'::regnamespace
        and proname in ('multi_entity_resolve_owner_context', 'multi_entity_assert_workspace_assigned',
                        'multi_entity_list_assigned_workspaces', 'multi_entity_get_assigned_workspace'))
    = 'multi_entity_assert_workspace_assigned={postgres=X/postgres},multi_entity_get_assigned_workspace={postgres=X/postgres,service_role=X/postgres},multi_entity_list_assigned_workspaces={postgres=X/postgres,service_role=X/postgres},multi_entity_resolve_owner_context={postgres=X/postgres,service_role=X/postgres}',
    'stage 5 acl');
  perform pg_temp.chk('A5 service_role still has NO direct privilege on the seat/assignment tables',
    not has_table_privilege('service_role', 'public.multi_entity_owner', 'select')
    and not has_table_privilege('service_role', 'public.multi_entity_assignments', 'select'), 'table acl');
end $$;

do $$
declare
  v text;
  role_name text;
  me1 text := '61000000-0000-4000-8000-000000000002';
  ws text := '62000000-0000-4000-8000-0000000000a1';
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    v := pg_temp.try_as(role_name, format('select * from public.multi_entity_list_workspace_aggregates(%L)', me1));
    perform pg_temp.chk('A6 ' || role_name || ' cannot EXECUTE list_workspace_aggregates', v like '42501:%', v);
    v := pg_temp.try_as(role_name, format('select * from public.multi_entity_get_workspace_aggregate(%L, %L)', me1, ws));
    perform pg_temp.chk('A6 ' || role_name || ' cannot EXECUTE get_workspace_aggregate', v like '42501:%', v);
    v := pg_temp.try_as(role_name, format('select * from public.multi_entity_compute_workspace_aggregate(%L, %L)', me1, ws));
    perform pg_temp.chk('A6 ' || role_name || ' cannot EXECUTE compute_workspace_aggregate', v like '42501:%', v);
  end loop;
  v := pg_temp.try_as('service_role', format('select * from public.multi_entity_compute_workspace_aggregate(%L, %L)', me1, ws));
  perform pg_temp.chk('A7 service_role cannot EXECUTE the internal compute function', v like '42501:%', v);
  v := pg_temp.try_as('service_role', format('select * from public.multi_entity_list_workspace_aggregates(%L)', me1));
  perform pg_temp.chk('A8 service_role CAN execute list (positive control)', v = 'OK', v);
  v := pg_temp.try_as('service_role', format('select * from public.multi_entity_get_workspace_aggregate(%L, %L)', me1, ws));
  perform pg_temp.chk('A8 service_role CAN execute get (positive control)', v = 'OK', v);
end $$;

-- ===========================================================================
-- B. AUTHORIZATION (principal, gate, freshness)
-- ===========================================================================
do $$
declare
  v text;
  v2 text;
  who record;
  a1 text := '62000000-0000-4000-8000-0000000000a1';
begin
  for who in select * from (values
      ('null',     null::text),
      ('platform', '61000000-0000-4000-8000-000000000001'),
      ('replacement-not-yet-seated', '61000000-0000-4000-8000-000000000003'),
      ('election', '61000000-0000-4000-8000-000000000004'),
      ('stranger', '61000000-0000-4000-8000-000000000005'),
      ('nonexistent', '6fffffff-0000-4000-8000-000000000000')) t(label, id)
  loop
    v := pg_temp.try_as('service_role', format('select * from public.multi_entity_list_workspace_aggregates(%L::uuid)', who.id));
    perform pg_temp.chk('B1 list refuses ' || who.label || ' principal', v like '%UNAUTHORIZED%', v);
    v := pg_temp.try_as('service_role', format('select * from public.multi_entity_get_workspace_aggregate(%L::uuid, %L)', who.id, a1));
    perform pg_temp.chk('B1 get refuses ' || who.label || ' principal (assigned ws)', v like '%UNAUTHORIZED%', v);
  end loop;

  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_get_workspace_aggregate('61000000-0000-4000-8000-000000000002', '62000000-0000-4000-8000-000000000099')$q$);
  v2 := pg_temp.try_as('service_role', $q$select * from public.multi_entity_get_workspace_aggregate('61000000-0000-4000-8000-000000000002', '6fffffff-0000-4000-8000-0000000000ff')$q$);
  perform pg_temp.chk('B2 unassigned workspace -> WORKSPACE_NOT_ASSIGNED', v like '%WORKSPACE_NOT_ASSIGNED%', v);
  perform pg_temp.chk('B2 nonexistent workspace -> the IDENTICAL refusal (no enumeration)', v2 = v, v2);
  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_get_workspace_aggregate('61000000-0000-4000-8000-000000000002', null)$q$);
  perform pg_temp.chk('B2 null workspace -> WORKSPACE_NOT_ASSIGNED', v like '%WORKSPACE_NOT_ASSIGNED%', v);
end $$;

-- B3 dual principal (D-8, simulated by direct SQL): refused, then restored.
insert into public.election_owners (workspace_id, auth_user_id, name, email)
values ('62000000-0000-4000-8000-000000000099', '61000000-0000-4000-8000-000000000002', 'S6 dual', 's6-me1@stage6.invalid');
do $$
declare v text;
begin
  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_list_workspace_aggregates('61000000-0000-4000-8000-000000000002')$q$);
  perform pg_temp.chk('B3 dual-principal seat holder refused by list', v like '%UNAUTHORIZED%', v);
  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_get_workspace_aggregate('61000000-0000-4000-8000-000000000002', '62000000-0000-4000-8000-0000000000a1')$q$);
  perform pg_temp.chk('B3 dual-principal seat holder refused by get', v like '%UNAUTHORIZED%', v);
end $$;
delete from public.election_owners where auth_user_id = '61000000-0000-4000-8000-000000000002';

-- B4 seat replacement: the old holder is refused on the next call, the new
-- holder sees the SAME assignments (no owner column); then restored.
update public.multi_entity_owner set auth_user_id = '61000000-0000-4000-8000-000000000003';
do $$
declare v text;
begin
  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_list_workspace_aggregates('61000000-0000-4000-8000-000000000002')$q$);
  perform pg_temp.chk('B4 replaced (old) holder refused', v like '%UNAUTHORIZED%', v);
  perform pg_temp.chk('B4 new holder sees all 9 current assignments',
    (select count(*) from public.multi_entity_list_workspace_aggregates('61000000-0000-4000-8000-000000000003')) = 9, 'rows');
end $$;
update public.multi_entity_owner set auth_user_id = '61000000-0000-4000-8000-000000000002';

-- B5 unassignment -> refused on the next call, absent from the list;
-- B6 new assignment -> visible on the next call. Both restored afterwards.
create temp table _saved_b0 as select * from public.multi_entity_assignments
  where workspace_id = '62000000-0000-4000-8000-0000000000b0';
delete from public.multi_entity_assignments where workspace_id = '62000000-0000-4000-8000-0000000000b0';
insert into public.multi_entity_assignments (workspace_id) values ('62000000-0000-4000-8000-000000000099');
do $$
declare v text;
begin
  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_get_workspace_aggregate('61000000-0000-4000-8000-000000000002', '62000000-0000-4000-8000-0000000000b0')$q$);
  perform pg_temp.chk('B5 unassigned mid-session -> WORKSPACE_NOT_ASSIGNED', v like '%WORKSPACE_NOT_ASSIGNED%', v);
  perform pg_temp.chk('B5 unassigned workspace absent from the list',
    not exists (select 1 from public.multi_entity_list_workspace_aggregates('61000000-0000-4000-8000-000000000002')
                where workspace_id = '62000000-0000-4000-8000-0000000000b0'), 'absent');
  perform pg_temp.chk('B6 newly assigned workspace readable on the next call',
    pg_temp.agg('61000000-0000-4000-8000-000000000002', '62000000-0000-4000-8000-000000000099') = 'reported|15|15|0|0|0|0|15',
    pg_temp.agg('61000000-0000-4000-8000-000000000002', '62000000-0000-4000-8000-000000000099'));
  perform pg_temp.chk('B6 newly assigned workspace present in the list',
    exists (select 1 from public.multi_entity_list_workspace_aggregates('61000000-0000-4000-8000-000000000002')
            where workspace_id = '62000000-0000-4000-8000-000000000099'), 'present');
end $$;
delete from public.multi_entity_assignments where workspace_id = '62000000-0000-4000-8000-000000000099';
insert into public.multi_entity_assignments select * from _saved_b0;

-- B7 zero assignments -> empty result (not an error) for the holder; still
-- UNAUTHORIZED for anyone else. Restored afterwards.
create temp table _saved_all as select * from public.multi_entity_assignments;
delete from public.multi_entity_assignments;
do $$
declare v text;
begin
  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_list_workspace_aggregates('61000000-0000-4000-8000-000000000002')$q$);
  perform pg_temp.chk('B7 zero assignments -> call succeeds', v = 'OK', v);
  perform pg_temp.chk('B7 zero assignments -> zero rows',
    (select count(*) from public.multi_entity_list_workspace_aggregates('61000000-0000-4000-8000-000000000002')) = 0, 'rows');
  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_list_workspace_aggregates('61000000-0000-4000-8000-000000000005')$q$);
  perform pg_temp.chk('B7 zero assignments never turns a stranger into an empty-success', v like '%UNAUTHORIZED%', v);
end $$;
insert into public.multi_entity_assignments select * from _saved_all;

-- ===========================================================================
-- C. AGGREGATE CORRECTNESS
-- ===========================================================================
do $$
declare
  me1 uuid := '61000000-0000-4000-8000-000000000002';
  got text;
  legacy_remaining int;
  foreign_reason_open int;
begin
  got := pg_temp.agg(me1, '62000000-0000-4000-8000-0000000000a1');
  perform pg_temp.chk('C1 BIG workspace = reported|12 total|3 voted|2 closed|7 remaining|1 needed|1 arranged|3 completed',
    got = 'reported|12|3|2|7|1|1|3', got);
  got := pg_temp.agg(me1, '62000000-0000-4000-8000-0000000000a2');
  perform pg_temp.chk('C2 all-voted workspace', got = 'reported|10|10|0|0|0|0|0', got);
  got := pg_temp.agg(me1, '62000000-0000-4000-8000-0000000000b0');
  perform pg_temp.chk('C3 exactly the threshold (10) is reported', got = 'reported|10|4|0|6|0|0|0', got);
  got := pg_temp.agg(me1, '62000000-0000-4000-8000-0000000000c0');
  perform pg_temp.chk('C4 one below the threshold (9) is suppressed with NO numbers', got = 'suppressed', got);
  got := pg_temp.agg(me1, '62000000-0000-4000-8000-0000000000d0');
  perform pg_temp.chk('C5 zero-row workspace is suppressed with NO numbers', got = 'suppressed', got);
  got := pg_temp.agg(me1, '62000000-0000-4000-8000-0000000000e0');
  perform pg_temp.chk('C6 one-row workspace is suppressed with NO numbers', got = 'suppressed', got);
  got := pg_temp.agg(me1, '62000000-0000-4000-8000-0000000000f0');
  perform pg_temp.chk('C7 ended workspace (20 contacts) releases NO numbers', got = 'ended', got);
  got := pg_temp.agg(me1, '62000000-0000-4000-8000-0000000000f1');
  perform pg_temp.chk('C8 election_end_at = now() exactly counts as ended (active is strictly >)', got = 'ended', got);
  got := pg_temp.agg(me1, '62000000-0000-4000-8000-0000000000f2');
  perform pg_temp.chk('C9 ends in 1 s -> still active and reported', got = 'reported|10|2|0|8|0|0|0', got);

  -- Parity with the existing SQL mirror of resolveFollowUpStatus. The ONLY
  -- permitted difference is the contact whose reason belongs to ANOTHER
  -- workspace: the legacy helper (no workspace containment) calls it closed,
  -- the dashboard (which resolves against the workspace's own reasons) and
  -- Stage 6 call it remaining.
  select count(*) filter (where public.election_day_voter_is_remaining(v.voted, v.not_voting_reason_id)),
         count(*) filter (where not v.voted and r.workspace_id is distinct from v.workspace_id and v.not_voting_reason_id is not null)
    into legacy_remaining, foreign_reason_open
  from public.election_day_voters v
  left join public.election_day_not_voting_reasons r on r.id = v.not_voting_reason_id
  where v.workspace_id = '62000000-0000-4000-8000-0000000000a1';
  perform pg_temp.chk('C10 remaining = legacy election_day_voter_is_remaining + foreign-reason contacts',
    legacy_remaining + foreign_reason_open = 7 and foreign_reason_open = 1,
    format('legacy=%s foreign=%s', legacy_remaining, foreign_reason_open));

  -- Invariants on EVERY reported row; no number on any other row.
  perform pg_temp.chk('C11 every reported row partitions exactly (voted+closed+remaining=total, rides<=total)',
    not exists (select 1 from public.multi_entity_list_workspace_aggregates(me1)
                where report_status = 'reported'
                  and (voted + follow_up_closed + follow_up_remaining <> contacts_total
                       or ride_needed + ride_arranged + ride_completed > contacts_total
                       or least(contacts_total, voted, follow_up_closed, follow_up_remaining,
                                ride_needed, ride_arranged, ride_completed) < 0)), 'invariants');
  perform pg_temp.chk('C12 withheld rows carry no number at all',
    not exists (select 1 from public.multi_entity_list_workspace_aggregates(me1)
                where report_status <> 'reported'
                  and coalesce(contacts_total, voted, follow_up_closed, follow_up_remaining,
                               ride_needed, ride_arranged, ride_completed) is not null), 'nulls');
  perform pg_temp.chk('C13 status set is exactly reported/suppressed/ended',
    not exists (select 1 from public.multi_entity_list_workspace_aggregates(me1)
                where report_status not in ('reported', 'suppressed', 'ended')), 'statuses');
end $$;

do $$
declare
  me1 uuid := '61000000-0000-4000-8000-000000000002';
  got_ids text;
  exp_ids text;
  run1 text;
  run2 text;
begin
  select string_agg(workspace_id::text, ',') into got_ids
  from public.multi_entity_list_workspace_aggregates(me1);
  select string_agg(w.id::text, ',' order by w.name, w.id) into exp_ids
  from public.multi_entity_assignments a join public.election_workspaces w on w.id = a.workspace_id;
  perform pg_temp.chk('C14 list = exactly the current assignments, ordered name then id', got_ids = exp_ids, got_ids);
  perform pg_temp.chk('C14 duplicate names are ordered by id (a1 before a2)',
    position('62000000-0000-4000-8000-0000000000a1' in got_ids) < position('62000000-0000-4000-8000-0000000000a2' in got_ids), 'order');
  perform pg_temp.chk('C15 unassigned workspace never appears (no cross-workspace leakage)',
    position('62000000-0000-4000-8000-000000000099' in got_ids) = 0, 'absent');

  select md5(string_agg(t::text, E'\n')) into run1 from public.multi_entity_list_workspace_aggregates(me1) t;
  select md5(string_agg(t::text, E'\n')) into run2 from public.multi_entity_list_workspace_aggregates(me1) t;
  perform pg_temp.chk('C16 deterministic: two calls return byte-identical results', run1 = run2, run1);

  perform pg_temp.chk('C17 list row == get row for every assigned workspace (one definition, two paths)',
    not exists (
      select 1 from public.multi_entity_list_workspace_aggregates(me1) l
      where (l.*)::text is distinct from (
        select (g.*)::text from public.multi_entity_get_workspace_aggregate(me1, l.workspace_id) g)), 'parity');

  perform pg_temp.chk('C18 BIG totals unaffected by the 15 voted contacts of the unassigned workspace',
    pg_temp.agg(me1, '62000000-0000-4000-8000-0000000000a1') = 'reported|12|3|2|7|1|1|3', 'no leakage');

  -- Sum over reported rows only (what the API totals are built from).
  perform pg_temp.chk('C19 released totals over reported rows',
    (select concat_ws('|', count(*), sum(contacts_total), sum(voted), sum(follow_up_closed), sum(follow_up_remaining),
                      sum(ride_needed), sum(ride_arranged), sum(ride_completed))
       from public.multi_entity_list_workspace_aggregates(me1) where report_status = 'reported')
    = '4|42|19|2|21|1|1|3', 'totals');
end $$;

-- ===========================================================================
-- D. READ-ONLY + STAGE 5 REGRESSION
-- ===========================================================================
do $$
declare
  me1 uuid := '61000000-0000-4000-8000-000000000002';
  before_voters bigint := (select count(*) from public.election_day_voters);
  before_updated text := (select md5(string_agg(id::text || updated_at::text, ',' order by id)) from public.election_day_voters);
begin
  perform count(*) from public.multi_entity_list_workspace_aggregates(me1);
  perform count(*) from public.multi_entity_get_workspace_aggregate(me1, '62000000-0000-4000-8000-0000000000a1');
  perform pg_temp.chk('D1 aggregate reads change no voter row (count + updated_at fingerprint)',
    before_voters = (select count(*) from public.election_day_voters)
    and before_updated = (select md5(string_agg(id::text || updated_at::text, ',' order by id)) from public.election_day_voters),
    'unchanged');
  perform pg_temp.chk('D2 Stage 5 list_assigned_workspaces still returns all 9 (ended included, metadata only)',
    (select count(*) from public.multi_entity_list_assigned_workspaces(me1)) = 9, 'rows');
  perform pg_temp.chk('D3 Stage 5 gate still refuses an unassigned workspace',
    pg_temp.try_as('postgres', $q$select public.multi_entity_assert_workspace_assigned('61000000-0000-4000-8000-000000000002', '62000000-0000-4000-8000-000000000099')$q$)
      like '%WORKSPACE_NOT_ASSIGNED%', 'gate');
end $$;

-- ===========================================================================
-- REPORT + VERDICT
-- ===========================================================================
select n, case when ok then 'PASS' else '**FAIL**' end as result, id, detail from _r order by n;
select count(*) filter (where ok) as pass, count(*) filter (where not ok) as fail, count(*) as total from _r;

do $$
declare f int := (select count(*) from _r where not ok);
begin
  if f > 0 then
    raise exception 'STAGE6_DB_SUITE_FAILED: % assertion(s) failed', f;
  end if;
end $$;

rollback;
