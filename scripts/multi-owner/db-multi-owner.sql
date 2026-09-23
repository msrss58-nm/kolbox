-- Multi-Entity MULTI-OWNER - DATABASE suite.
--
-- The question this answers: with several Multi-Entity Owners alive at once,
-- can one of them see, or act on, a workspace that is not assigned to THEM?
-- Every check below is written to fail if the owner predicate is missing from
-- any read path - which is exactly the defect the singleton model could not
-- have (there was only ever one owner) and the defect multi-owner introduces
-- if a single join is left unfiltered.
--
-- Run ONLY against the isolated scratch stack (scripts/stage5/mkScratchStack.mjs):
--   docker exec -i supabase_db_kolboxs5 psql -U postgres -v ON_ERROR_STOP=1 < scripts/multi-owner/db-multi-owner.sql
--
-- Everything runs inside ONE transaction that is ROLLED BACK at the end, so
-- the suite is re-runnable and leaves no rows behind. Synthetic identities
-- only (uuid literals + *.invalid emails). Exit code is non-zero on any
-- failed assertion.

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

-- Clean slate INSIDE the transaction (rolled back at the end).
delete from public.multi_entity_assignments;
delete from public.multi_entity_owner;
delete from public.election_owners;
delete from public.election_workspace_pending_owner_access;
delete from public.platform_owners;

insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
  ('60000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','mo-po@multiowner.invalid', now(), now()),
  ('60000000-0000-4000-8000-00000000000a','00000000-0000-0000-0000-000000000000','authenticated','authenticated','mo-a@multiowner.invalid', now(), now()),
  ('60000000-0000-4000-8000-00000000000b','00000000-0000-0000-0000-000000000000','authenticated','authenticated','mo-b@multiowner.invalid', now(), now()),
  ('60000000-0000-4000-8000-00000000000c','00000000-0000-0000-0000-000000000000','authenticated','authenticated','mo-c@multiowner.invalid', now(), now()),
  ('60000000-0000-4000-8000-0000000000ff','00000000-0000-0000-0000-000000000000','authenticated','authenticated','mo-stranger@multiowner.invalid', now(), now());

insert into public.platform_owners (auth_user_id, name, email)
values ('60000000-0000-4000-8000-000000000001', 'MO Platform Owner', 'mo-po@multiowner.invalid');

insert into public.election_workspaces (id, name, election_end_at, login_code) values
  ('61000000-0000-4000-8000-00000000000a', 'MO Alpha',  now() + interval '10 days', public.election_day_generate_workspace_login_code()),
  ('61000000-0000-4000-8000-00000000000b', 'MO Beta',   now() + interval '10 days', public.election_day_generate_workspace_login_code()),
  ('61000000-0000-4000-8000-00000000000c', 'MO Shared', now() + interval '10 days', public.election_day_generate_workspace_login_code());

-- ===========================================================================
-- A. SCHEMA - the singleton is gone and cannot come back by accident
-- ===========================================================================
do $$
begin
  perform pg_temp.chk('A1 the singleton CHECK is gone',
    not exists (select 1 from pg_constraint where conname = 'multi_entity_owner_singleton'), '');
  perform pg_temp.chk('A2 the owner PK is owner_id (uuid), not a boolean',
    (select pg_get_constraintdef(oid) from pg_constraint
      where conname = 'multi_entity_owner_pkey'
        and conrelid = 'public.multi_entity_owner'::regclass) = 'PRIMARY KEY (owner_id)',
    (select pg_get_constraintdef(oid) from pg_constraint where conname = 'multi_entity_owner_pkey'));
  perform pg_temp.chk('A3 one Auth account still holds at most ONE seat',
    exists (select 1 from pg_constraint where conname = 'multi_entity_owner_auth_user_id_key'), '');
  perform pg_temp.chk('A4 assignments are unique PER OWNER, not per workspace',
    exists (select 1 from pg_constraint where conname = 'multi_entity_assignments_owner_workspace_key')
      and not exists (select 1 from pg_constraint where conname = 'multi_entity_assignments_workspace_id_key'), '');
  perform pg_temp.chk('A5 assignments.owner_id is NOT NULL (an unowned row would mean "everyone")',
    (select attnotnull from pg_attribute
      where attrelid = 'public.multi_entity_assignments'::regclass and attname = 'owner_id'), '');
  -- The ACL must be EXACTLY as before: this migration grants nothing new.
  perform pg_temp.chk('A6 multi_entity_owner is still postgres-only (no new grant)',
    (select coalesce(relacl::text, 'owner-only') from pg_class
      where oid = 'public.multi_entity_owner'::regclass) in ('owner-only', '{postgres=arwdDxtm/postgres}'),
    (select coalesce(relacl::text, 'owner-only') from pg_class where oid = 'public.multi_entity_owner'::regclass));
  perform pg_temp.chk('A7 multi_entity_assignments is still postgres-only',
    (select coalesce(relacl::text, 'owner-only') from pg_class
      where oid = 'public.multi_entity_assignments'::regclass) in ('owner-only', '{postgres=arwdDxtm/postgres}'),
    (select coalesce(relacl::text, 'owner-only') from pg_class where oid = 'public.multi_entity_assignments'::regclass));
  perform pg_temp.chk('A8 the workspace-scope gate is still executable by NO role',
    not has_function_privilege('anon', 'public.multi_entity_assert_workspace_assigned(uuid,uuid)', 'execute')
      and not has_function_privilege('authenticated', 'public.multi_entity_assert_workspace_assigned(uuid,uuid)', 'execute')
      and not has_function_privilege('service_role', 'public.multi_entity_assert_workspace_assigned(uuid,uuid)', 'execute'), '');
  -- Phase-independent: the _v2 contract must be present exactly once in BOTH
  -- the EXPAND and the post-CONTRACT state (the legacy signatures are covered
  -- by db-expand-compat.sql, which is phase-specific by design).
  perform pg_temp.chk('A9 exactly ONE _v2 overload of each owner-addressed operation',
    (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
      and p.proname in ('platform_assign_workspace_v2', 'platform_unassign_workspace_v2',
                        'platform_provision_multi_entity_owner_v2')) = 3,
    (select string_agg(p.proname, ',' order by p.proname) from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname like 'platform_%_v2'));
  perform pg_temp.chk('A10 ... and exactly one removal operation',
    (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
      and p.proname = 'platform_remove_multi_entity_owner') = 1, '');
end $$;

-- ===========================================================================
-- B. THREE CONCURRENT OWNERS - the thing that was structurally impossible
-- ===========================================================================
do $$
declare
  a jsonb; b jsonb; c jsonb;
  oa uuid; ob uuid; oc uuid;
begin
  a := public.platform_provision_multi_entity_owner_v2(
    '60000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-00000000000a','Owner A','mo-a@multiowner.invalid','0501112222', null);
  b := public.platform_provision_multi_entity_owner_v2(
    '60000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-00000000000b','Owner B','mo-b@multiowner.invalid','0501112223', null);
  c := public.platform_provision_multi_entity_owner_v2(
    '60000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-00000000000c','Owner C','mo-c@multiowner.invalid','0501112224', null);

  oa := (a->>'owner_id')::uuid; ob := (b->>'owner_id')::uuid; oc := (c->>'owner_id')::uuid;

  perform pg_temp.chk('B1 three owners exist concurrently',
    (select count(*) from public.multi_entity_owner) = 3,
    (select count(*)::text from public.multi_entity_owner));
  perform pg_temp.chk('B2 each got a DISTINCT owner_id',
    oa is not null and ob is not null and oc is not null and oa <> ob and ob <> oc and oa <> oc, '');
  perform pg_temp.chk('B3 adding an owner is never reported as a replacement',
    (a->>'replaced') = 'false' and (b->>'replaced') = 'false' and (c->>'replaced') = 'false', a::text);
  perform pg_temp.chk('B4 each ADD wrote its own provisioned audit row, attributed to that owner',
    (select count(*) from public.multi_entity_audit
      where action = 'provisioned' and owner_id in (oa, ob, oc)) = 3, '');

  -- Re-adding the SAME identity is idempotent metadata refresh, not a 4th owner.
  a := public.platform_provision_multi_entity_owner_v2(
    '60000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-00000000000a','Owner A Renamed','mo-a@multiowner.invalid','0501112299', null);
  perform pg_temp.chk('B5 re-adding the same identity is idempotent - still three owners',
    (select count(*) from public.multi_entity_owner) = 3 and (a->>'already_existed') = 'true'
      and (a->>'owner_id')::uuid = oa, a::text);
  perform pg_temp.chk('B6 ... and it refreshed the display metadata',
    (select name from public.multi_entity_owner where owner_id = oa) = 'Owner A Renamed', '');

  -- Cross-principal exclusivity is unchanged.
  insert into public.election_owners (workspace_id, auth_user_id, name, email)
  values ('61000000-0000-4000-8000-00000000000a','60000000-0000-4000-8000-0000000000ff','EO','mo-stranger@multiowner.invalid');
  begin
    perform public.platform_provision_multi_entity_owner_v2(
      '60000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-0000000000ff','X','x@multiowner.invalid','0501112225', null);
    perform pg_temp.chk('B7 an Election Owner still cannot become a Multi-Entity Owner', false, 'no exception');
  exception when others then
    perform pg_temp.chk('B7 an Election Owner still cannot become a Multi-Entity Owner',
      sqlerrm like '%IDENTITY_ALREADY_PRINCIPAL%', sqlerrm);
  end;
  delete from public.election_owners where auth_user_id = '60000000-0000-4000-8000-0000000000ff';
end $$;

-- ===========================================================================
-- C. ASSIGNMENT ISOLATION - the core of this change
-- ===========================================================================
do $$
declare
  oa uuid := (select owner_id from public.multi_entity_owner where auth_user_id = '60000000-0000-4000-8000-00000000000a');
  ob uuid := (select owner_id from public.multi_entity_owner where auth_user_id = '60000000-0000-4000-8000-00000000000b');
  r jsonb;
begin
  -- A gets Alpha + Shared. B gets Beta + Shared. C gets nothing.
  perform public.platform_assign_workspace_v2('60000000-0000-4000-8000-000000000001', oa, '61000000-0000-4000-8000-00000000000a');
  perform public.platform_assign_workspace_v2('60000000-0000-4000-8000-000000000001', oa, '61000000-0000-4000-8000-00000000000c');
  perform public.platform_assign_workspace_v2('60000000-0000-4000-8000-000000000001', ob, '61000000-0000-4000-8000-00000000000b');
  r := public.platform_assign_workspace_v2('60000000-0000-4000-8000-000000000001', ob, '61000000-0000-4000-8000-00000000000c');

  perform pg_temp.chk('C1 THE SAME WORKSPACE is assigned to two different owners',
    (select count(*) from public.multi_entity_assignments
      where workspace_id = '61000000-0000-4000-8000-00000000000c') = 2
      and (r->>'already_assigned') = 'false',
    r::text);

  perform pg_temp.chk('C2 owner A sees exactly Alpha + Shared',
    (select string_agg(name, ',' order by name)
       from public.multi_entity_list_assigned_workspaces('60000000-0000-4000-8000-00000000000a')) = 'MO Alpha,MO Shared',
    (select string_agg(name, ',' order by name) from public.multi_entity_list_assigned_workspaces('60000000-0000-4000-8000-00000000000a')));

  perform pg_temp.chk('C3 owner B sees exactly Beta + Shared - NOT Alpha',
    (select string_agg(name, ',' order by name)
       from public.multi_entity_list_assigned_workspaces('60000000-0000-4000-8000-00000000000b')) = 'MO Beta,MO Shared',
    (select string_agg(name, ',' order by name) from public.multi_entity_list_assigned_workspaces('60000000-0000-4000-8000-00000000000b')));

  perform pg_temp.chk('C4 owner C, assigned nothing, sees NOTHING (and is not refused)',
    (select count(*) from public.multi_entity_list_assigned_workspaces('60000000-0000-4000-8000-00000000000c')) = 0, '');

  -- The gate itself, directly. This is the predicate every read depends on.
  begin
    perform public.multi_entity_assert_workspace_assigned(
      '60000000-0000-4000-8000-00000000000b', '61000000-0000-4000-8000-00000000000a');
    perform pg_temp.chk('C5 owner B is REFUSED owner A''s workspace by the gate', false, 'no exception');
  exception when others then
    perform pg_temp.chk('C5 owner B is REFUSED owner A''s workspace by the gate',
      sqlerrm like '%WORKSPACE_NOT_ASSIGNED%', sqlerrm);
  end;

  begin
    perform public.multi_entity_assert_workspace_assigned(
      '60000000-0000-4000-8000-00000000000a', '61000000-0000-4000-8000-00000000000a');
    perform pg_temp.chk('C6 ... and ALLOWED their own (C5 is not a blanket refusal)', true, '');
  exception when others then
    perform pg_temp.chk('C6 ... and ALLOWED their own (C5 is not a blanket refusal)', false, sqlerrm);
  end;

  -- Single-workspace read, the per-workspace leak path.
  perform pg_temp.chk('C7 get_assigned_workspace returns A''s own workspace',
    (select count(*) from public.multi_entity_get_assigned_workspace(
      '60000000-0000-4000-8000-00000000000a', '61000000-0000-4000-8000-00000000000a')) = 1, '');
  begin
    perform public.multi_entity_get_assigned_workspace(
      '60000000-0000-4000-8000-00000000000c', '61000000-0000-4000-8000-00000000000a');
    perform pg_temp.chk('C8 an unassigned owner cannot read a single workspace either', false, 'no exception');
  exception when others then
    perform pg_temp.chk('C8 an unassigned owner cannot read a single workspace either',
      sqlerrm like '%WORKSPACE_NOT_ASSIGNED%', sqlerrm);
  end;

  -- assigned_at must be the CALLING owner's own timestamp on a shared workspace.
  perform pg_temp.chk('C9 on a SHARED workspace each owner sees their OWN assigned_at',
    (select assigned_at from public.multi_entity_get_assigned_workspace(
       '60000000-0000-4000-8000-00000000000a','61000000-0000-4000-8000-00000000000c'))
    = (select assigned_at from public.multi_entity_assignments
        where owner_id = oa and workspace_id = '61000000-0000-4000-8000-00000000000c'), '');
end $$;

-- ===========================================================================
-- D. AGGREGATES - the business-data leak path
-- ===========================================================================
do $$
declare
  n int;
begin
  -- ALPHA: entitled + 12 contacts -> reports real numbers.
  -- SHARED: entitled + 3 contacts -> under the min-10 floor -> suppressed.
  -- BETA: NOT entitled -> unavailable (that branch runs BEFORE the floor).
  insert into public.election_workspace_modules (workspace_id, module_key) values
    ('61000000-0000-4000-8000-00000000000a','election_day'),
    ('61000000-0000-4000-8000-00000000000c','election_day')
  on conflict do nothing;
  insert into public.election_day_voters (workspace_id, masad, first_name, last_name, street, house_number, city, coordinator)
  select '61000000-0000-4000-8000-00000000000a', 'M', 'V'||g, 'L', 'St', 1, 'C', ''
  from generate_series(1, 12) g;
  insert into public.election_day_voters (workspace_id, masad, first_name, last_name, street, house_number, city, coordinator)
  select '61000000-0000-4000-8000-00000000000c', 'M', 'S'||g, 'L', 'St', 1, 'C', ''
  from generate_series(1, 3) g;

  select count(*) into n from public.multi_entity_list_workspace_aggregates('60000000-0000-4000-8000-00000000000a');
  perform pg_temp.chk('D1 owner A''s aggregate list covers exactly their two workspaces', n = 2, n::text);

  select count(*) into n from public.multi_entity_list_workspace_aggregates('60000000-0000-4000-8000-00000000000b');
  perform pg_temp.chk('D2 owner B''s aggregate list covers exactly their two workspaces', n = 2, n::text);

  perform pg_temp.chk('D3 owner A sees Alpha''s real counts',
    (select contacts_total from public.multi_entity_list_workspace_aggregates('60000000-0000-4000-8000-00000000000a')
      where name = 'MO Alpha') = 12,
    (select coalesce(contacts_total, -1)::text from public.multi_entity_list_workspace_aggregates('60000000-0000-4000-8000-00000000000a') where name = 'MO Alpha'));

  perform pg_temp.chk('D4 owner B''s aggregate list does NOT contain Alpha at all',
    not exists (select 1 from public.multi_entity_list_workspace_aggregates('60000000-0000-4000-8000-00000000000b')
      where name = 'MO Alpha'), '');

  begin
    perform public.multi_entity_get_workspace_aggregate(
      '60000000-0000-4000-8000-00000000000b', '61000000-0000-4000-8000-00000000000a');
    perform pg_temp.chk('D5 owner B cannot read Alpha''s aggregate directly either', false, 'no exception - LEAK');
  exception when others then
    perform pg_temp.chk('D5 owner B cannot read Alpha''s aggregate directly either',
      sqlerrm like '%WORKSPACE_NOT_ASSIGNED%', sqlerrm);
  end;

  perform pg_temp.chk('D6 privacy unchanged: under the reporting floor -> suppressed, metrics NULL (never zero)',
    (select report_status from public.multi_entity_list_workspace_aggregates('60000000-0000-4000-8000-00000000000a')
      where name = 'MO Shared') = 'suppressed'
      and (select contacts_total from public.multi_entity_list_workspace_aggregates('60000000-0000-4000-8000-00000000000a')
            where name = 'MO Shared') is null,
    (select report_status from public.multi_entity_list_workspace_aggregates('60000000-0000-4000-8000-00000000000a') where name = 'MO Shared'));

  perform pg_temp.chk('D6b ... and an UNENTITLED workspace is unavailable, also with metrics NULL',
    (select report_status from public.multi_entity_list_workspace_aggregates('60000000-0000-4000-8000-00000000000b')
      where name = 'MO Beta') = 'unavailable'
      and (select contacts_total from public.multi_entity_list_workspace_aggregates('60000000-0000-4000-8000-00000000000b')
            where name = 'MO Beta') is null,
    (select report_status from public.multi_entity_list_workspace_aggregates('60000000-0000-4000-8000-00000000000b') where name = 'MO Beta'));

  perform pg_temp.chk('D6c the SHARED workspace reports the SAME numbers to both owners (one workspace, one truth)',
    (select report_status from public.multi_entity_list_workspace_aggregates('60000000-0000-4000-8000-00000000000a') where name = 'MO Shared')
    = (select report_status from public.multi_entity_list_workspace_aggregates('60000000-0000-4000-8000-00000000000b') where name = 'MO Shared'), '');

  perform pg_temp.chk('D7 a stranger holding no seat is refused outright, never given an empty list',
    pg_temp.try_as('postgres',
      $q$select * from public.multi_entity_list_workspace_aggregates('60000000-0000-4000-8000-0000000000ff')$q$)
    like '%UNAUTHORIZED%', '');
end $$;

-- ===========================================================================
-- E. UNASSIGN / REMOVE - revoking one owner must not touch the others
-- ===========================================================================
do $$
declare
  oa uuid := (select owner_id from public.multi_entity_owner where auth_user_id = '60000000-0000-4000-8000-00000000000a');
  ob uuid := (select owner_id from public.multi_entity_owner where auth_user_id = '60000000-0000-4000-8000-00000000000b');
  r jsonb;
begin
  r := public.platform_unassign_workspace_v2('60000000-0000-4000-8000-000000000001', oa, '61000000-0000-4000-8000-00000000000c');
  perform pg_temp.chk('E1 unassigning A from the SHARED workspace removed exactly one row',
    (r->>'removed') = 'true'
      and (select count(*) from public.multi_entity_assignments
            where workspace_id = '61000000-0000-4000-8000-00000000000c') = 1, r::text);
  perform pg_temp.chk('E2 ... and owner B STILL sees the shared workspace',
    exists (select 1 from public.multi_entity_list_assigned_workspaces('60000000-0000-4000-8000-00000000000b')
      where name = 'MO Shared'), '');
  perform pg_temp.chk('E3 ... and owner A no longer does',
    not exists (select 1 from public.multi_entity_list_assigned_workspaces('60000000-0000-4000-8000-00000000000a')
      where name = 'MO Shared'), '');

  r := public.platform_unassign_workspace_v2('60000000-0000-4000-8000-000000000001', oa, '61000000-0000-4000-8000-00000000000c');
  perform pg_temp.chk('E4 unassigning again is a successful no-op with no audit row',
    (r->>'removed') = 'false' and r->>'audit_id' is null, r::text);

  -- Removal.
  r := public.platform_remove_multi_entity_owner('60000000-0000-4000-8000-000000000001', ob);
  perform pg_temp.chk('E5 removing owner B reports their Auth id for the separate purge',
    (r->>'removed') = 'true'
      and (r->>'previous_auth_user_id')::uuid = '60000000-0000-4000-8000-00000000000b'::uuid,
    r::text);
  perform pg_temp.chk('E6 owner B is gone and their assignments went with them',
    (select count(*) from public.multi_entity_owner where owner_id = ob) = 0
      and (select count(*) from public.multi_entity_assignments where owner_id = ob) = 0, '');
  perform pg_temp.chk('E7 the OTHER owners are untouched',
    (select count(*) from public.multi_entity_owner) = 2
      and exists (select 1 from public.multi_entity_list_assigned_workspaces('60000000-0000-4000-8000-00000000000a')
                   where name = 'MO Alpha'), '');
  perform pg_temp.chk('E8 removal wrote a ''removed'' audit row attributed to that owner',
    exists (select 1 from public.multi_entity_audit
      where action = 'removed' and owner_id = ob
        and previous_auth_user_id = '60000000-0000-4000-8000-00000000000b'), '');
  perform pg_temp.chk('E9 the removed owner is now refused everywhere',
    pg_temp.try_as('postgres',
      $q$select * from public.multi_entity_list_assigned_workspaces('60000000-0000-4000-8000-00000000000b')$q$)
    like '%UNAUTHORIZED%', '');

  -- The removed holder's Auth account must still be purgeable - without this,
  -- removal would strand an account forever.
  perform pg_temp.chk('E10 a REMOVED owner''s Auth account is purgeable (not only a replaced one)',
    (public.platform_check_auth_user_purgeable(
       '60000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-00000000000b')->>'purgeable') = 'true',
    public.platform_check_auth_user_purgeable('60000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-00000000000b')::text);
  perform pg_temp.chk('E11 ... and it appears in the console''s durable cleanup queue',
    (public.platform_get_multi_entity_state('60000000-0000-4000-8000-000000000001')
      ->'pending_auth_cleanup')::text like '%60000000-0000-4000-8000-00000000000b%', '');

  begin
    perform public.platform_remove_multi_entity_owner(
      '60000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000000');
    perform pg_temp.chk('E12 removing a nonexistent owner is refused', false, 'no exception');
  exception when others then
    perform pg_temp.chk('E12 removing a nonexistent owner is refused',
      sqlerrm like '%MULTI_ENTITY_OWNER_NOT_FOUND%', sqlerrm);
  end;

  begin
    perform public.platform_assign_workspace_v2(
      '60000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000000','61000000-0000-4000-8000-00000000000a');
    perform pg_temp.chk('E13 assigning to a nonexistent owner is refused even though OTHER owners exist', false, 'no exception');
  exception when others then
    perform pg_temp.chk('E13 assigning to a nonexistent owner is refused even though OTHER owners exist',
      sqlerrm like '%MULTI_ENTITY_OWNER_NOT_PROVISIONED%', sqlerrm);
  end;
end $$;

-- ===========================================================================
-- F. REPLACEMENT - still works, still owner-scoped
-- ===========================================================================
do $$
declare
  oa uuid := (select owner_id from public.multi_entity_owner where auth_user_id = '60000000-0000-4000-8000-00000000000a');
  r jsonb;
begin
  r := public.platform_provision_multi_entity_owner_v2(
    '60000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-0000000000ff',
    'Owner A Successor','mo-stranger@multiowner.invalid','0501112230', oa);

  perform pg_temp.chk('F1 replacing a NAMED owner keeps the same owner_id',
    (r->>'replaced') = 'true' and (r->>'owner_id')::uuid = oa
      and (r->>'previous_auth_user_id')::uuid = '60000000-0000-4000-8000-00000000000a'::uuid, r::text);
  perform pg_temp.chk('F2 ... and does not create a new owner',
    (select count(*) from public.multi_entity_owner) = 2, '');
  perform pg_temp.chk('F3 ... and the successor inherits that owner''s assignments',
    (select string_agg(name, ',' order by name)
      from public.multi_entity_list_assigned_workspaces('60000000-0000-4000-8000-0000000000ff')) = 'MO Alpha', '');
  perform pg_temp.chk('F4 ... and the predecessor is refused',
    pg_temp.try_as('postgres',
      $q$select * from public.multi_entity_list_assigned_workspaces('60000000-0000-4000-8000-00000000000a')$q$)
    like '%UNAUTHORIZED%', '');

  begin
    perform public.platform_provision_multi_entity_owner_v2(
      '60000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-00000000000c',
      'X','x@multiowner.invalid','0501112231','00000000-0000-4000-8000-000000000000');
    perform pg_temp.chk('F5 replacing a nonexistent owner is refused', false, 'no exception');
  exception when others then
    perform pg_temp.chk('F5 replacing a nonexistent owner is refused',
      sqlerrm like '%MULTI_ENTITY_OWNER_NOT_FOUND%', sqlerrm);
  end;
end $$;

-- ===========================================================================
-- G. THE CONSOLE STATE READ
-- ===========================================================================
do $$
declare s jsonb;
begin
  s := public.platform_get_multi_entity_state('60000000-0000-4000-8000-000000000001');
  -- Phase-independent. Under EXPAND the legacy `seat` key still EXISTS for
  -- the previous deployment, but must be json-null once several owners exist
  -- rather than naming an arbitrary one; under CONTRACT the key is gone
  -- entirely. Both satisfy the real invariant: `owners` is authoritative and
  -- `seat` never points at one of several.
  perform pg_temp.chk('G1 the state read returns EVERY owner, and never an arbitrary single seat',
    pg_catalog.jsonb_array_length(s->'owners') = 2
      and (s->'seat' is null or s->'seat' = 'null'::jsonb),
    'owners=' || pg_catalog.jsonb_array_length(s->'owners')::text
      || ' seat=' || coalesce((s->'seat')::text, 'absent'));
  perform pg_temp.chk('G2 each owner carries their own assigned workspace ids',
    exists (select 1 from jsonb_array_elements(s->'owners') o
      where pg_catalog.jsonb_array_length(o->'assigned_workspace_ids') = 1), s->'owners'->0->>'assigned_workspace_ids');
  perform pg_temp.chk('G3 each workspace reports WHICH owners hold it',
    exists (select 1 from jsonb_array_elements(s->'workspaces') w
      where w->>'name' = 'MO Alpha' and pg_catalog.jsonb_array_length(w->'assigned_owner_ids') = 1), '');
  perform pg_temp.chk('G4 an unassigned workspace reports an empty owner list, not null',
    (select w->'assigned_owner_ids' from jsonb_array_elements(s->'workspaces') w
      where w->>'name' = 'MO Beta') = '[]'::jsonb, '');
  perform pg_temp.chk('G5 login_code is still present (a tenant selector, not a secret)',
    exists (select 1 from jsonb_array_elements(s->'workspaces') w where w->>'login_code' is not null), '');
  perform pg_temp.chk('G6 a non-Platform-Owner is refused the state read',
    pg_temp.try_as('postgres',
      $q$select public.platform_get_multi_entity_state('60000000-0000-4000-8000-00000000000c')$q$)
    like '%UNAUTHORIZED%', '');
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
    raise exception 'MULTI_OWNER_DB_SUITE_FAILED: % assertion(s) failed', f;
  end if;
end $$;

rollback;
