-- Platform Stage 5 - DATABASE suite (ACL, resolver, entity gate, cascade,
-- and the rebuilt Stage 4/4B RPC regression after the service_role revoke).
--
-- Run ONLY against the isolated scratch stack (scripts/stage5/mkScratchStack.mjs):
--   docker exec -i supabase_db_kolboxs5 psql -U postgres -v ON_ERROR_STOP=1 < scripts/stage5/db-stage5.sql
--
-- Everything runs inside ONE transaction that is ROLLED BACK at the end, so
-- the suite is re-runnable and leaves no rows behind. Synthetic identities
-- only (uuid literals + *.invalid emails). Exit code is non-zero on any
-- failed assertion (the final DO block raises).
--
-- Role-scoped checks use pg_temp.try_as(role, sql): the statement runs under
-- `set local role <role>` inside a subtransaction, so a refusal is captured as
-- its SQLSTATE instead of aborting the suite, and the role is always restored.

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

-- ---------------------------------------------------------------------------
-- Clean slate INSIDE the transaction (rolled back at the end): the scratch
-- stack may carry rows from the API/UI suites.
-- ---------------------------------------------------------------------------
delete from public.multi_entity_assignments;
delete from public.multi_entity_owner;
delete from public.election_owners;
delete from public.election_workspace_pending_owner_access;
delete from public.platform_owners;

insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
  ('51000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','s5-po@stage5.invalid', now(), now()),
  ('51000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','s5-me1@stage5.invalid', now(), now()),
  ('51000000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','s5-me2@stage5.invalid', now(), now()),
  ('51000000-0000-4000-8000-000000000004','00000000-0000-0000-0000-000000000000','authenticated','authenticated','s5-eo@stage5.invalid', now(), now()),
  ('51000000-0000-4000-8000-000000000005','00000000-0000-0000-0000-000000000000','authenticated','authenticated','s5-stranger@stage5.invalid', now(), now()),
  ('51000000-0000-4000-8000-000000000006','00000000-0000-0000-0000-000000000000','authenticated','authenticated','s5-orphan@stage5.invalid', now(), now());

insert into public.platform_owners (auth_user_id, name, email)
values ('51000000-0000-4000-8000-000000000001', 'S5 Platform Owner', 's5-po@stage5.invalid');

insert into public.election_workspaces (id, name, election_end_at, login_code) values
  ('52000000-0000-4000-8000-00000000000a', 'S5 Beta',  now() + interval '10 days', public.election_day_generate_workspace_login_code()),
  ('52000000-0000-4000-8000-00000000000b', 'S5 Alpha', now() + interval '10 days', public.election_day_generate_workspace_login_code()),
  ('52000000-0000-4000-8000-00000000000c', 'S5 Gamma', now() - interval '1 day',   public.election_day_generate_workspace_login_code()),
  ('52000000-0000-4000-8000-00000000000d', 'S5 Alpha', now() + interval '20 days', public.election_day_generate_workspace_login_code());

insert into public.election_owners (workspace_id, auth_user_id, name, email)
values ('52000000-0000-4000-8000-00000000000c', '51000000-0000-4000-8000-000000000004', 'S5 Election Owner', 's5-eo@stage5.invalid');

-- ===========================================================================
-- A. CATALOG / ACL
-- ===========================================================================
do $$
declare
  r record;
  n int := 0;
begin
  for r in
    select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args,
           pg_get_userbyid(p.proowner) as owner, p.prosecdef, p.provolatile::text as vol,
           coalesce(array_to_string(p.proconfig, ','), '') as cfg,
           coalesce(p.proacl::text, '<null>') as acl
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('multi_entity_resolve_owner_context', 'multi_entity_assert_workspace_assigned',
                        'multi_entity_list_assigned_workspaces', 'multi_entity_get_assigned_workspace')
  loop
    n := n + 1;
    perform pg_temp.chk('A1 ' || r.proname || ' owner/secdef/stable/search_path',
      r.owner = 'postgres' and r.prosecdef and r.vol = 's' and r.cfg = 'search_path=""',
      format('owner=%s secdef=%s vol=%s cfg=%s', r.owner, r.prosecdef, r.vol, r.cfg));
    if r.proname = 'multi_entity_assert_workspace_assigned' then
      perform pg_temp.chk('A2 ' || r.proname || ' proacl (no role at all)',
        r.acl = '{postgres=X/postgres}', r.acl);
    else
      perform pg_temp.chk('A2 ' || r.proname || ' proacl (service_role only)',
        r.acl = '{postgres=X/postgres,service_role=X/postgres}', r.acl);
    end if;
  end loop;
  perform pg_temp.chk('A0 exactly 4 Stage 5 functions, one overload each', n = 4, 'found ' || n);
end $$;

do $$
declare
  v text;
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    v := pg_temp.try_as(role_name, $q$select * from public.multi_entity_resolve_owner_context('51000000-0000-4000-8000-000000000002')$q$);
    perform pg_temp.chk('A3 ' || role_name || ' cannot EXECUTE resolve_owner_context', v like '42501:%', v);
    v := pg_temp.try_as(role_name, $q$select * from public.multi_entity_list_assigned_workspaces('51000000-0000-4000-8000-000000000002')$q$);
    perform pg_temp.chk('A3 ' || role_name || ' cannot EXECUTE list_assigned_workspaces', v like '42501:%', v);
    v := pg_temp.try_as(role_name, $q$select * from public.multi_entity_get_assigned_workspace('51000000-0000-4000-8000-000000000002', '52000000-0000-4000-8000-00000000000a')$q$);
    perform pg_temp.chk('A3 ' || role_name || ' cannot EXECUTE get_assigned_workspace', v like '42501:%', v);
    v := pg_temp.try_as(role_name, $q$select public.multi_entity_assert_workspace_assigned('51000000-0000-4000-8000-000000000002', '52000000-0000-4000-8000-00000000000a')$q$);
    perform pg_temp.chk('A3 ' || role_name || ' cannot EXECUTE assert_workspace_assigned', v like '42501:%', v);
  end loop;
  v := pg_temp.try_as('service_role', $q$select public.multi_entity_assert_workspace_assigned('51000000-0000-4000-8000-000000000002', '52000000-0000-4000-8000-00000000000a')$q$);
  perform pg_temp.chk('A4 service_role cannot EXECUTE the internal helper', v like '42501:%', v);
end $$;

do $$
declare
  acl_owner text := (select coalesce(relacl::text, '') from pg_class where oid = 'public.multi_entity_owner'::regclass);
  acl_assign text := (select coalesce(relacl::text, '') from pg_class where oid = 'public.multi_entity_assignments'::regclass);
  acl_audit text := (select coalesce(relacl::text, '') from pg_class where oid = 'public.multi_entity_audit'::regclass);
  v text;
  role_name text;
  stmt text;
begin
  perform pg_temp.chk('A5 multi_entity_owner relacl = postgres only', acl_owner = '{postgres=arwdDxtm/postgres}', acl_owner);
  perform pg_temp.chk('A5 multi_entity_assignments relacl = postgres only', acl_assign = '{postgres=arwdDxtm/postgres}', acl_assign);
  perform pg_temp.chk('A5 multi_entity_audit relacl unchanged (postgres only)', acl_audit = '{postgres=arwdDxtm/postgres}', acl_audit);

  foreach role_name in array array['service_role', 'anon', 'authenticated'] loop
    foreach stmt in array array[
      'select count(*) from public.multi_entity_owner',
      'update public.multi_entity_owner set name = name',
      'delete from public.multi_entity_owner',
      $q$insert into public.multi_entity_owner (auth_user_id, name, email) values ('51000000-0000-4000-8000-000000000005', 'x', 'x@stage5.invalid')$q$,
      'select count(*) from public.multi_entity_assignments',
      $q$insert into public.multi_entity_assignments (workspace_id) values ('52000000-0000-4000-8000-00000000000c')$q$,
      'delete from public.multi_entity_assignments',
      'truncate public.multi_entity_assignments'
    ] loop
      v := pg_temp.try_as(role_name, stmt);
      perform pg_temp.chk('A6 ' || role_name || ' direct table access denied: ' || left(stmt, 48), v like '42501:%', v);
    end loop;
  end loop;
end $$;

do $$
begin
  perform pg_temp.chk('A7 list/get result columns are exactly the metadata projection (no login_code)',
    pg_get_function_result('public.multi_entity_list_assigned_workspaces(uuid)'::regprocedure)
      = 'TABLE(workspace_id uuid, name text, election_end_at timestamp with time zone, assigned_at timestamp with time zone)'
    and pg_get_function_result('public.multi_entity_get_assigned_workspace(uuid,uuid)'::regprocedure)
      = 'TABLE(workspace_id uuid, name text, election_end_at timestamp with time zone, assigned_at timestamp with time zone)',
    pg_get_function_result('public.multi_entity_list_assigned_workspaces(uuid)'::regprocedure));
end $$;

-- ===========================================================================
-- S. STAGE 4 / 4B RPC REGRESSION - executed AS service_role (the role the API
--    uses), i.e. after the table revoke. Rebuilt coverage.
-- ===========================================================================
do $$
declare
  v text;
  st jsonb;
  audit_before int := (select count(*) from public.multi_entity_audit);
begin
  v := pg_temp.try_as('service_role', $q$select public.platform_get_multi_entity_state('51000000-0000-4000-8000-000000000001')$q$);
  perform pg_temp.chk('S1 platform_get_multi_entity_state executes as service_role', v = 'OK', v);

  v := pg_temp.try_as('service_role', $q$select public.platform_provision_multi_entity_owner('51000000-0000-4000-8000-000000000005', '51000000-0000-4000-8000-000000000002', 'Me One', 's5-me1@stage5.invalid', null)$q$);
  perform pg_temp.chk('S2 provision refuses a non-Platform-Owner caller', v like '%UNAUTHORIZED%', v);

  v := pg_temp.try_as('service_role', $q$select public.platform_provision_multi_entity_owner('51000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000004', 'EO', 's5-eo@stage5.invalid', null)$q$);
  perform pg_temp.chk('S3 D-6 forward: Election Owner identity refused', v like '%IDENTITY_ALREADY_PRINCIPAL%', v);

  v := pg_temp.try_as('service_role', $q$select public.platform_provision_multi_entity_owner('51000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000002', 'Me One', 's5-me1@stage5.invalid', null)$q$);
  perform pg_temp.chk('S4 first provision as service_role', v = 'OK', v);
  perform pg_temp.chk('S4 seat row written through the definer',
    (select count(*) from public.multi_entity_owner where auth_user_id = '51000000-0000-4000-8000-000000000002') = 1, 'seat');
  perform pg_temp.chk('S4 provisioned audit row',
    exists (select 1 from public.multi_entity_audit where action = 'provisioned' and seat_auth_user_id = '51000000-0000-4000-8000-000000000002'), 'audit');

  audit_before := (select count(*) from public.multi_entity_audit);
  v := pg_temp.try_as('service_role', $q$select public.platform_provision_multi_entity_owner('51000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000002', 'Me One Renamed', 's5-me1@stage5.invalid', null)$q$);
  perform pg_temp.chk('S5 idempotent re-provision of the same identity', v = 'OK'
    and (select name from public.multi_entity_owner) = 'Me One Renamed'
    and (select count(*) from public.multi_entity_audit) = audit_before, v);

  v := pg_temp.try_as('service_role', $q$select public.platform_assign_workspace('51000000-0000-4000-8000-000000000001', '52000000-0000-4000-8000-00000000000a')$q$);
  perform pg_temp.chk('S6 assign W-Beta as service_role', v = 'OK', v);
  v := pg_temp.try_as('service_role', $q$select public.platform_assign_workspace('51000000-0000-4000-8000-000000000001', '52000000-0000-4000-8000-00000000000b')$q$);
  perform pg_temp.chk('S6 assign W-Alpha(b) as service_role', v = 'OK', v);
  v := pg_temp.try_as('service_role', $q$select public.platform_assign_workspace('51000000-0000-4000-8000-000000000001', '52000000-0000-4000-8000-00000000000d')$q$);
  perform pg_temp.chk('S6 assign W-Alpha(d) as service_role', v = 'OK', v);
  v := pg_temp.try_as('service_role', $q$select public.platform_assign_workspace('51000000-0000-4000-8000-000000000001', '52000000-0000-4000-8000-0000000000ff')$q$);
  perform pg_temp.chk('S6 assign nonexistent workspace refused', v like '%WORKSPACE_NOT_FOUND%', v);
  perform pg_temp.chk('S6 three assignments + assigned audit rows',
    (select count(*) from public.multi_entity_assignments) = 3
    and (select count(*) from public.multi_entity_audit where action = 'assigned') >= 3, 'state');

  select public.platform_get_multi_entity_state('51000000-0000-4000-8000-000000000001') into st;
  -- Scoped to THIS suite's four workspaces: other suites may leave their own
  -- workspaces on the scratch stack, so a global count is not an invariant.
  perform pg_temp.chk('S7 state RPC reports the seat and all 4 suite workspaces (3 assigned)',
    st -> 'seat' ->> 'auth_user_id' = '51000000-0000-4000-8000-000000000002'
    and (select count(*) from jsonb_array_elements(st -> 'workspaces') e
         where e ->> 'workspace_id' like '52000000-0000-4000-8000-00000000000%') = 4
    and (select count(*) from jsonb_array_elements(st -> 'workspaces') e
         where e ->> 'workspace_id' like '52000000-0000-4000-8000-00000000000%'
           and (e ->> 'is_assigned')::boolean) = 3,
    left(st::text, 160));
end $$;

-- ===========================================================================
-- R / L / G. RESOLVER, LIST, GET (entity gate)
-- ===========================================================================
do $$
declare
  v text;
  n int;
  nm text;
  ids uuid[];
begin
  v := pg_temp.try_as('service_role', 'select * from public.multi_entity_resolve_owner_context(null)');
  perform pg_temp.chk('R1 null id refused', v like '%UNAUTHORIZED%', v);
  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_resolve_owner_context('51000000-0000-4000-8000-000000000005')$q$);
  perform pg_temp.chk('R2 non-holder refused', v like '%UNAUTHORIZED%', v);
  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_resolve_owner_context('51000000-0000-4000-8000-000000000001')$q$);
  perform pg_temp.chk('R2 Platform Owner is not the Multi-Entity principal', v like '%UNAUTHORIZED%', v);
  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_resolve_owner_context('51000000-0000-4000-8000-000000000004')$q$);
  perform pg_temp.chk('R2 Election Owner is not the Multi-Entity principal', v like '%UNAUTHORIZED%', v);

  select count(*), max(name) into n, nm from public.multi_entity_resolve_owner_context('51000000-0000-4000-8000-000000000002');
  perform pg_temp.chk('R3 seat holder resolves to exactly one row', n = 1 and nm = 'Me One Renamed', format('n=%s name=%s', n, nm));
  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_resolve_owner_context('51000000-0000-4000-8000-000000000002')$q$);
  perform pg_temp.chk('R3 seat holder resolves as service_role', v = 'OK', v);

  -- D-8 reverse direction, simulated by direct SQL (the only way it can happen).
  insert into public.election_owners (workspace_id, auth_user_id, name, email)
  values ('52000000-0000-4000-8000-00000000000b', '51000000-0000-4000-8000-000000000002', 'dual', 's5-me1@stage5.invalid');
  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_resolve_owner_context('51000000-0000-4000-8000-000000000002')$q$);
  perform pg_temp.chk('R4 dual principal (also Election Owner) refused', v like '%UNAUTHORIZED%', v);
  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_list_assigned_workspaces('51000000-0000-4000-8000-000000000002')$q$);
  perform pg_temp.chk('R4 dual principal cannot list workspaces', v like '%UNAUTHORIZED%', v);
  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_get_assigned_workspace('51000000-0000-4000-8000-000000000002', '52000000-0000-4000-8000-00000000000a')$q$);
  perform pg_temp.chk('R4 dual principal cannot read an assigned workspace', v like '%UNAUTHORIZED%', v);
  delete from public.election_owners where auth_user_id = '51000000-0000-4000-8000-000000000002';

  update public.platform_owners set auth_user_id = '51000000-0000-4000-8000-000000000002';
  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_resolve_owner_context('51000000-0000-4000-8000-000000000002')$q$);
  perform pg_temp.chk('R5 dual principal (also Platform Owner) refused', v like '%UNAUTHORIZED%', v);
  update public.platform_owners set auth_user_id = '51000000-0000-4000-8000-000000000001';
  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_resolve_owner_context('51000000-0000-4000-8000-000000000002')$q$);
  perform pg_temp.chk('R6 exclusivity restored -> accepted again', v = 'OK', v);

  -- LIST: exact set, total order (name asc, then id asc), metadata only.
  select array_agg(workspace_id order by ord) into ids
  from (select workspace_id, row_number() over () as ord
        from public.multi_entity_list_assigned_workspaces('51000000-0000-4000-8000-000000000002')) t;
  perform pg_temp.chk('L1 list = the 3 assigned workspaces in (name, id) order',
    ids = array['52000000-0000-4000-8000-00000000000b', '52000000-0000-4000-8000-00000000000d', '52000000-0000-4000-8000-00000000000a']::uuid[],
    coalesce(ids::text, '<null>'));

  -- GET: assigned allowed; unassigned / nonexistent / null identical refusal.
  select count(*) into n from public.multi_entity_get_assigned_workspace('51000000-0000-4000-8000-000000000002', '52000000-0000-4000-8000-00000000000a');
  perform pg_temp.chk('G1 assigned workspace -> one row', n = 1, 'n=' || n);
  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_get_assigned_workspace('51000000-0000-4000-8000-000000000002', '52000000-0000-4000-8000-00000000000a')$q$);
  perform pg_temp.chk('G1 assigned workspace readable as service_role', v = 'OK', v);
  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_get_assigned_workspace('51000000-0000-4000-8000-000000000002', '52000000-0000-4000-8000-00000000000c')$q$);
  perform pg_temp.chk('G2 existing but unassigned workspace refused', v = 'P0001:WORKSPACE_NOT_ASSIGNED', v);
  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_get_assigned_workspace('51000000-0000-4000-8000-000000000002', '52000000-0000-4000-8000-0000000000ff')$q$);
  perform pg_temp.chk('G3 nonexistent workspace -> IDENTICAL refusal', v = 'P0001:WORKSPACE_NOT_ASSIGNED', v);
  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_get_assigned_workspace('51000000-0000-4000-8000-000000000002', null)$q$);
  perform pg_temp.chk('G4 null workspace -> identical refusal', v = 'P0001:WORKSPACE_NOT_ASSIGNED', v);
  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_get_assigned_workspace('51000000-0000-4000-8000-000000000005', '52000000-0000-4000-8000-00000000000a')$q$);
  perform pg_temp.chk('G5 non-holder cannot read an assigned workspace', v like '%UNAUTHORIZED%', v);

  -- Unassignment takes effect immediately (no cache anywhere).
  v := pg_temp.try_as('service_role', $q$select public.platform_unassign_workspace('51000000-0000-4000-8000-000000000001', '52000000-0000-4000-8000-00000000000a')$q$);
  perform pg_temp.chk('G6 unassign as service_role', v = 'OK', v);
  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_get_assigned_workspace('51000000-0000-4000-8000-000000000002', '52000000-0000-4000-8000-00000000000a')$q$);
  perform pg_temp.chk('G6 unassigned workspace refused on the next call', v = 'P0001:WORKSPACE_NOT_ASSIGNED', v);
  select count(*) into n from public.multi_entity_list_assigned_workspaces('51000000-0000-4000-8000-000000000002');
  perform pg_temp.chk('G6 list shrinks to 2', n = 2, 'n=' || n);
end $$;

-- ===========================================================================
-- P. REPLACEMENT + PURGE (Stage 4A/4B) and stale-seat refusal
-- ===========================================================================
do $$
declare
  v text;
  j jsonb;
  n int;
begin
  v := pg_temp.try_as('service_role', $q$select public.platform_provision_multi_entity_owner('51000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000003', 'Me Two', 's5-me2@stage5.invalid', null)$q$);
  perform pg_temp.chk('P1 replacement as service_role', v = 'OK', v);
  perform pg_temp.chk('P1 replaced audit row names the previous holder',
    exists (select 1 from public.multi_entity_audit where action = 'replaced'
            and seat_auth_user_id = '51000000-0000-4000-8000-000000000003'
            and previous_auth_user_id = '51000000-0000-4000-8000-000000000002'), 'audit');
  select count(*) into n from public.multi_entity_list_assigned_workspaces('51000000-0000-4000-8000-000000000003');
  perform pg_temp.chk('P2 assignments carried over to the new holder', n = 2, 'n=' || n);
  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_resolve_owner_context('51000000-0000-4000-8000-000000000002')$q$);
  perform pg_temp.chk('P3 replaced (stale) holder refused immediately', v like '%UNAUTHORIZED%', v);
  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_get_assigned_workspace('51000000-0000-4000-8000-000000000002', '52000000-0000-4000-8000-00000000000b')$q$);
  perform pg_temp.chk('P3 stale holder cannot read a still-assigned workspace', v like '%UNAUTHORIZED%', v);

  select public.platform_check_auth_user_purgeable('51000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000002') into j;
  perform pg_temp.chk('P4 replaced account is purgeable', (j ->> 'purgeable')::boolean, j::text);
  select public.platform_check_auth_user_purgeable('51000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000003') into j;
  perform pg_temp.chk('P4 CURRENT holder is not purgeable (runbook: purge first is impossible)',
    not (j ->> 'purgeable')::boolean, j::text);
  v := pg_temp.try_as('service_role', $q$select public.platform_check_auth_user_purgeable('51000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000002')$q$);
  perform pg_temp.chk('P4 purge guard executes as service_role', v = 'OK', v);
  v := pg_temp.try_as('service_role', $q$select public.platform_record_multi_entity_auth_cleanup('51000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000002', true)$q$);
  perform pg_temp.chk('P5 cleanup recorder executes as service_role', v = 'OK', v);
  select public.platform_check_auth_user_purgeable('51000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000002') into j;
  perform pg_temp.chk('P5 purge now reports already_completed', (j ->> 'already_completed')::boolean, j::text);

  -- Provisioning-orphan lifecycle (Stage 4B).
  v := pg_temp.try_as('service_role', $q$select public.platform_record_provisioning_auth_mint('51000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000006', 's5-orphan@stage5.invalid')$q$);
  perform pg_temp.chk('P6 mint recorder executes as service_role', v = 'OK', v);
  select public.platform_check_provisioning_orphan_purgeable('51000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000006') into j;
  perform pg_temp.chk('P6 minted, never-seated account is a purgeable orphan', (j ->> 'purgeable')::boolean, j::text);
  v := pg_temp.try_as('service_role', $q$select public.platform_check_provisioning_orphan_purgeable('51000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000006')$q$);
  perform pg_temp.chk('P6 orphan guard executes as service_role', v = 'OK', v);
  v := pg_temp.try_as('service_role', $q$select public.platform_record_provisioning_orphan_cleanup('51000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000006', true)$q$);
  perform pg_temp.chk('P7 orphan cleanup recorder executes as service_role', v = 'OK', v);
  select public.platform_check_provisioning_orphan_purgeable('51000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000006') into j;
  perform pg_temp.chk('P7 orphan now reports already_completed', (j ->> 'already_completed')::boolean, j::text);
end $$;

-- ===========================================================================
-- C. CASCADES still work with service_role holding no table privilege
-- ===========================================================================
do $$
declare
  v text;
  n_assign_before int := (select count(*) from public.multi_entity_assignments);
begin
  -- Workspace delete cascades its assignment (FK runs as table owner).
  v := pg_temp.try_as('postgres', $q$delete from public.election_workspaces where id = '52000000-0000-4000-8000-00000000000d'$q$);
  perform pg_temp.chk('C1 workspace delete succeeds', v = 'OK', v);
  perform pg_temp.chk('C1 its assignment cascaded away',
    not exists (select 1 from public.multi_entity_assignments where workspace_id = '52000000-0000-4000-8000-00000000000d')
    and (select count(*) from public.multi_entity_assignments) = n_assign_before - 1, 'cascade');
  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_get_assigned_workspace('51000000-0000-4000-8000-000000000003', '52000000-0000-4000-8000-00000000000d')$q$);
  perform pg_temp.chk('C1 deleted workspace -> identical refusal', v = 'P0001:WORKSPACE_NOT_ASSIGNED', v);

  -- Deleting the CURRENT seat holder's Auth user must still cascade-delete the
  -- seat row despite the service_role revoke. (postgres cannot SET ROLE to
  -- supabase_auth_admin on this image; the real GoTrue path - auth.admin.
  -- deleteUser, which runs as supabase_auth_admin - is proven end to end in
  -- scripts/stage5/api-real-local.mjs.)
  v := pg_temp.try_as('postgres', $q$delete from auth.users where id = '51000000-0000-4000-8000-000000000003'$q$);
  perform pg_temp.chk('C2 current seat holder auth user delete succeeds', v = 'OK', v);
  perform pg_temp.chk('C2 seat row removed by the FK cascade',
    (select count(*) from public.multi_entity_owner) = 0, 'seat rows=' || (select count(*) from public.multi_entity_owner));
  perform pg_temp.chk('C2 assignments survive (no owner column) for the next holder',
    (select count(*) from public.multi_entity_assignments) = n_assign_before - 1, 'assignments');
  v := pg_temp.try_as('service_role', $q$select * from public.multi_entity_resolve_owner_context('51000000-0000-4000-8000-000000000003')$q$);
  perform pg_temp.chk('C2 deleted user refused', v like '%UNAUTHORIZED%', v);
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
    raise exception 'STAGE5_DB_SUITE_FAILED: % assertion(s) failed', f;
  end if;
end $$;

rollback;
