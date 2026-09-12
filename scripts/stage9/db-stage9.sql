-- Platform Stage 9 - DATABASE suite: Election Owner administration + workspace
-- module entitlements (migration 20260916000000). Covers catalog/ACL/RLS, the
-- Manager-role seed, Owner user management (same-workspace, one-time proofs,
-- Manager reset refusal), Election Day entitlement enforcement for workers,
-- Multi-Entity aggregates vs entitlements ('unavailable', no counts), approval-
-- with-modules -> provisioning, the FAIL-CLOSED legacy approval, Platform
-- entitlement read/edit, the append-only entitlement audit (content,
-- immutability, atomicity), the is_manager role surface, and the closed
-- worker/bootstrap/6-argument-approval functions.
--
-- Run ONLY against the isolated scratch stack (scripts/stage5/mkScratchStack.mjs):
--   docker exec -i supabase_db_kolboxs5 psql -U postgres -v ON_ERROR_STOP=1 < scripts/stage9/db-stage9.sql
--
-- ONE transaction, ROLLED BACK at the end: re-runnable, leaves no rows.
-- Synthetic identities only. Non-zero exit on any failed assertion.
-- (The existing-workspace BACKFILL is proven by the upgrade replay, not here:
-- a fresh replay has no pre-existing workspace to backfill.)

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

create function pg_temp.try_sql(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return 'OK';
exception when others then
  return sqlstate || ':' || sqlerrm;
end $$;

create function pg_temp.h(p text) returns bytea
language sql as $$ select extensions.digest(p, 'sha256') $$;

create function pg_temp.audit(p_ws uuid, p_action text, p_module text) returns bigint
language sql as $$
  select count(*) from public.platform_entitlement_audit
  where workspace_id_snapshot = p_ws and action = p_action and module_key = p_module
$$;

-- ---------------------------------------------------------------------------
-- Fixtures (inside the rolled-back transaction)
-- ---------------------------------------------------------------------------
delete from public.multi_entity_assignments;
delete from public.multi_entity_owner;
delete from public.election_owners;
delete from public.election_workspace_pending_owner_access;
delete from public.platform_owners;

insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, created_at, updated_at) values
  ('91000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','po@s9.invalid',       '{}', now(), now()),
  ('91000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','owner-a@s9.invalid',  '{}', now(), now()),
  ('91000000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','owner-b@s9.invalid',  '{}', now(), now()),
  ('91000000-0000-4000-8000-000000000004','00000000-0000-0000-0000-000000000000','authenticated','authenticated','owner-d@s9.invalid',  '{}', now(), now()),
  ('91000000-0000-4000-8000-000000000005','00000000-0000-0000-0000-000000000000','authenticated','authenticated','legacy@s9.invalid',   '{}', now(), now()),
  ('91000000-0000-4000-8000-000000000006','00000000-0000-0000-0000-000000000000','authenticated','authenticated','pending@s9.invalid',  '{}', now(), now()),
  ('91000000-0000-4000-8000-000000000007','00000000-0000-0000-0000-000000000000','authenticated','authenticated','stranger@s9.invalid', '{}', now(), now()),
  ('91000000-0000-4000-8000-000000000008','00000000-0000-0000-0000-000000000000','authenticated','authenticated','me@s9.invalid',       '{}', now(), now());

insert into public.platform_owners (auth_user_id, name, email)
values ('91000000-0000-4000-8000-000000000001', 'S9 Platform Owner', 'po@s9.invalid');

-- A: Election Day. B: Election Day (0 contacts -> suppressed). D: Budget ONLY
-- (12 contacts - the leakage probe). F: ENDED, no entitlement (15 contacts).
insert into public.election_workspaces (id, name, election_end_at, login_code) values
  ('92000000-0000-4000-8000-000000000001', 'S9 A', now() + interval '10 days', public.election_day_generate_workspace_login_code()),
  ('92000000-0000-4000-8000-000000000002', 'S9 B', now() + interval '10 days', public.election_day_generate_workspace_login_code()),
  ('92000000-0000-4000-8000-000000000003', 'S9 D', now() + interval '10 days', public.election_day_generate_workspace_login_code()),
  ('92000000-0000-4000-8000-000000000004', 'S9 F', now() - interval '1 day',   public.election_day_generate_workspace_login_code());

insert into public.election_owners (workspace_id, auth_user_id, name, email) values
  ('92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000002', 'Owner A', 'owner-a@s9.invalid'),
  ('92000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000003', 'Owner B', 'owner-b@s9.invalid'),
  ('92000000-0000-4000-8000-000000000003', '91000000-0000-4000-8000-000000000004', 'Owner D', 'owner-d@s9.invalid');

select public.election_day_seed_new_workspace('92000000-0000-4000-8000-000000000001');
select public.election_day_seed_new_workspace('92000000-0000-4000-8000-000000000002');
select public.election_day_seed_new_workspace('92000000-0000-4000-8000-000000000003');

insert into public.election_workspace_modules (workspace_id, module_key) values
  ('92000000-0000-4000-8000-000000000001', 'election_day'),
  ('92000000-0000-4000-8000-000000000002', 'election_day'),
  ('92000000-0000-4000-8000-000000000003', 'budget');

insert into public.election_day_voters (workspace_id, first_name, last_name, voted)
  select '92000000-0000-4000-8000-000000000001', 'S9', 'a-' || g, g <= 6 from generate_series(1, 12) g;
insert into public.election_day_voters (workspace_id, first_name, last_name, voted, ride_requested, ride_arranged, ride_completed)
  select '92000000-0000-4000-8000-000000000003', 'S9', 'd-' || g, true, true, true, true from generate_series(1, 12) g;
insert into public.election_day_voters (workspace_id, first_name, last_name, voted)
  select '92000000-0000-4000-8000-000000000004', 'S9', 'f-' || g, true from generate_series(1, 15) g;

insert into public.multi_entity_owner (auth_user_id, name, email)
values ('91000000-0000-4000-8000-000000000008', 'S9 Seat', 'me@s9.invalid');
insert into public.multi_entity_assignments (workspace_id) values
  ('92000000-0000-4000-8000-000000000001'),
  ('92000000-0000-4000-8000-000000000002'),
  ('92000000-0000-4000-8000-000000000003'),
  ('92000000-0000-4000-8000-000000000004');

-- A legacy (pre-Stage-9) approval: no recorded module choice, no approver.
insert into public.election_workspace_pending_owner_access
  (id, auth_user_id, name, email, status, expires_at) values
  ('93000000-0000-4000-8000-000000000005', '91000000-0000-4000-8000-000000000005', 'Legacy', 'legacy@s9.invalid', 'pending', now() + interval '3 days');

-- ===========================================================================
-- Tests
-- ===========================================================================
do $$
declare
  po constant uuid := '91000000-0000-4000-8000-000000000001';
  oa constant uuid := '91000000-0000-4000-8000-000000000002';
  ob constant uuid := '91000000-0000-4000-8000-000000000003';
  od constant uuid := '91000000-0000-4000-8000-000000000004';
  legacy constant uuid := '91000000-0000-4000-8000-000000000005';
  pend constant uuid := '91000000-0000-4000-8000-000000000006';
  stranger constant uuid := '91000000-0000-4000-8000-000000000007';
  me constant uuid := '91000000-0000-4000-8000-000000000008';
  wa constant uuid := '92000000-0000-4000-8000-000000000001';
  wb constant uuid := '92000000-0000-4000-8000-000000000002';
  wd constant uuid := '92000000-0000-4000-8000-000000000003';
  wf constant uuid := '92000000-0000-4000-8000-000000000004';
  svc_fns constant text[] := array[
    'election_day_owner_has_module', 'election_day_list_workspace_modules_owner_v3',
    'election_day_list_permission_users_owner_v3', 'election_day_create_permission_user_owner_v3',
    'election_day_delete_permission_user_owner_v3', 'election_day_reset_permission_user_password_owner_v3',
    'platform_list_workspace_modules', 'platform_set_workspace_modules'];
  a_mgr_role uuid;
  a_ops_role uuid;
  d_ops_role uuid;
  code_a text;
  code_d text;
  am uuid;
  ao uuid;
  r text;
  j jsonb;
  v_pending uuid;
  v_ws uuid;
  v_role uuid;
  ws_before bigint;
  audit_before bigint;
begin
  select id into a_mgr_role from public.election_day_roles where workspace_id = wa and name = 'מנהל';
  select id into a_ops_role from public.election_day_roles where workspace_id = wa and name = 'טלפן/ית';
  select id into d_ops_role from public.election_day_roles where workspace_id = wd and name = 'טלפן/ית';
  select login_code into code_a from public.election_workspaces where id = wa;
  select login_code into code_d from public.election_workspaces where id = wd;

  -- ---- catalog / ACL / RLS ------------------------------------------------
  perform pg_temp.chk('CAT1 module catalog: voter_management, election_day (available), budget',
    (select string_agg(key || ':' || available, ',' order by sort_order) from public.platform_modules)
      = 'voter_management:false,election_day:true,budget:false',
    (select string_agg(key || ':' || available, ',' order by sort_order) from public.platform_modules));
  perform pg_temp.chk('CAT2 entitlement + audit tables: RLS on, zero policies',
    (select bool_and(c.relrowsecurity) from pg_class c where c.oid in (
      'public.platform_modules'::regclass, 'public.election_workspace_modules'::regclass,
      'public.platform_entitlement_audit'::regclass))
    and (select count(*) from pg_policies where schemaname = 'public'
      and tablename in ('platform_modules', 'election_workspace_modules', 'platform_entitlement_audit')) = 0, 'rls');
  perform pg_temp.chk('CAT3 anon/authenticated: no privilege on any of the three tables',
    not has_table_privilege('anon', 'public.platform_modules', 'SELECT')
    and not has_table_privilege('authenticated', 'public.election_workspace_modules', 'INSERT')
    and not has_table_privilege('anon', 'public.platform_entitlement_audit', 'SELECT')
    and not has_table_privilege('authenticated', 'public.platform_entitlement_audit', 'INSERT'), 'grants');
  perform pg_temp.chk('CAT4 service_role: SELECT-only on the catalog; nothing on entitlements or the audit',
    has_table_privilege('service_role', 'public.platform_modules', 'SELECT')
    and not has_table_privilege('service_role', 'public.platform_modules', 'INSERT')
    and not has_table_privilege('service_role', 'public.election_workspace_modules', 'SELECT')
    and not has_table_privilege('service_role', 'public.election_workspace_modules', 'INSERT')
    and not has_table_privilege('service_role', 'public.platform_entitlement_audit', 'SELECT')
    and not has_table_privilege('service_role', 'public.platform_entitlement_audit', 'INSERT')
    and not has_table_privilege('service_role', 'public.platform_entitlement_audit', 'TRUNCATE'), 'svc');
  perform pg_temp.chk('CAT5 new service-role functions: DEFINER, search_path empty, proacl exactly postgres+service_role',
    (select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = 'public' and p.proname = any(svc_fns) and p.prosecdef
        and array_to_string(p.proconfig, ',') = 'search_path=""'
        and p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}') = array_length(svc_fns, 1),
    (select string_agg(p.proname || '=' || coalesce(p.proacl::text, 'null'), ' ; ')
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = 'public' and p.proname = any(svc_fns)));
  perform pg_temp.chk('CAT6 internal helpers + audit trigger fn + ME compute granted to NO role',
    (select bool_and(p.proacl::text = '{postgres=X/postgres}') from pg_proc p where p.oid in (
      'public.election_day_normalize_modules(text[])'::regprocedure,
      'public.election_day_workspace_has_module(uuid,text)'::regprocedure,
      'public.platform_entitlement_audit_prevent_mutation()'::regprocedure,
      'public.multi_entity_compute_workspace_aggregate(uuid,uuid)'::regprocedure)), 'internal');
  perform pg_temp.chk('CAT7 new overloads (approval w/ modules, role create/update w/ is_manager, role read) service_role-only',
    (select bool_and(p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}')
      from pg_proc p where p.oid in (
        'public.platform_create_pending_owner_access(uuid,uuid,text,text,text,integer,text[])'::regprocedure,
        'public.election_day_create_role_owner_v3(uuid,bytea,text,text,text[],text,boolean)'::regprocedure,
        'public.election_day_update_role_owner_v3(uuid,bytea,uuid,text,text,text[],text,boolean)'::regprocedure,
        'public.election_day_list_roles_owner_v3(uuid)'::regprocedure)), 'overloads');
  perform pg_temp.chk('CAT8 callable by NO role: worker user-management RPCs, first-user bootstrap, 6-argument approval',
    (select bool_and(not has_function_privilege('service_role', p.oid, 'EXECUTE')
                 and not has_function_privilege('anon', p.oid, 'EXECUTE')
                 and not has_function_privilege('authenticated', p.oid, 'EXECUTE'))
      from pg_proc p where p.oid in (
        'public.election_day_create_permission_user_v3(bytea,bytea,text,text,uuid)'::regprocedure,
        'public.election_day_delete_permission_user_v3(bytea,bytea,uuid)'::regprocedure,
        'public.election_day_reset_permission_user_password_v3(bytea,bytea,uuid,text)'::regprocedure,
        'public.election_day_list_permission_users_v3(bytea)'::regprocedure,
        'public.election_day_bootstrap_first_permission_user(uuid,bytea,text,text,uuid)'::regprocedure,
        'public.platform_create_pending_owner_access(uuid,uuid,text,text,text,integer)'::regprocedure)), 'closed');
  perform pg_temp.chk('CAT9 service_role really cannot run the closed worker create or the 6-argument approval (42501)',
    pg_temp.try_as('service_role', format(
      'select * from public.election_day_create_permission_user_v3(%L, %L, %L, %L, %L)',
      pg_temp.h('s'), pg_temp.h('p'), 'x', 'y', a_mgr_role)) like '42501%'
    and pg_temp.try_as('service_role', format(
      'select * from public.platform_create_pending_owner_access(%L, %L, %L, %L, null, 7)',
      po, stranger, 'S', 'stranger@s9.invalid')) like '42501%', 'svc');
  perform pg_temp.chk('CAT10 anon/authenticated cannot call the Owner user-management RPCs (42501)',
    pg_temp.try_as('anon', format('select * from public.election_day_list_permission_users_owner_v3(%L)', oa)) like '42501%'
    and pg_temp.try_as('authenticated', format(
      'select * from public.election_day_create_permission_user_owner_v3(%L, %L, %L, %L, %L)',
      oa, pg_temp.h('x'), 'n', 'p', a_mgr_role)) like '42501%', 'anon/auth');
  perform pg_temp.chk('CAT11 resolve_session, login_v3 and the ME readers keep their service_role-only ACL',
    (select bool_and(p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}') from pg_proc p where p.oid in (
      'public.election_day_resolve_session(bytea)'::regprocedure,
      'public.election_day_login_v3(text,text,text,bytea)'::regprocedure,
      'public.multi_entity_get_workspace_aggregate(uuid,uuid)'::regprocedure,
      'public.multi_entity_list_workspace_aggregates(uuid)'::regprocedure)), 'acl');
  perform pg_temp.chk('CAT12 audit immutability triggers present (row UPDATE/DELETE + statement TRUNCATE)',
    (select count(*) from pg_trigger t where t.tgrelid = 'public.platform_entitlement_audit'::regclass
      and not t.tgisinternal) = 2, 'triggers');

  -- ---- Manager-role seed --------------------------------------------------
  perform pg_temp.chk('SEED1 new workspace seed: only the manager role is is_manager',
    (select string_agg(name || ':' || is_manager, ',' order by name) from public.election_day_roles where workspace_id = wa)
      = 'טלפן/ית:false,מנהל:true,נציג קלפי:false',
    (select string_agg(name || ':' || is_manager, ',' order by name) from public.election_day_roles where workspace_id = wa));

  -- ---- Owner user management: zero users is a valid state --------------------
  perform pg_temp.chk('USR1 a freshly provisioned workspace lists ZERO users (valid, no bootstrap)',
    (select count(*) from public.election_day_list_permission_users_owner_v3(oa)) = 0, 'empty');

  perform public.election_day_owner_reauth(oa, 'create_permission_user', pg_temp.h('a-create-1'));
  select u.id into am from public.election_day_create_permission_user_owner_v3(oa, pg_temp.h('a-create-1'), 'a-manager', 'pw-am', a_mgr_role) u;
  perform pg_temp.chk('USR2 Owner creates the first Manager in its own workspace',
    am is not null and (select workspace_id from public.election_day_permission_users where id = am) = wa, am::text);

  perform public.election_day_owner_reauth(oa, 'create_permission_user', pg_temp.h('a-create-2'));
  select u.id into ao from public.election_day_create_permission_user_owner_v3(oa, pg_temp.h('a-create-2'), 'a-ordinary', 'pw-ao', a_ops_role) u;
  perform pg_temp.chk('USR3 Owner creates an ordinary user', ao is not null, ao::text);

  r := pg_temp.try_sql(format('select * from public.election_day_create_permission_user_owner_v3(%L, pg_temp.h(%L), %L, %L, %L)', oa, 'a-create-2', 'again', 'pw', a_ops_role));
  perform pg_temp.chk('USR4 a consumed proof cannot be reused (UNAUTHORIZED)', r like '%UNAUTHORIZED%', r);

  perform public.election_day_owner_reauth(oa, 'create_role', pg_temp.h('a-wrong-action'));
  r := pg_temp.try_sql(format('select * from public.election_day_create_permission_user_owner_v3(%L, pg_temp.h(%L), %L, %L, %L)', oa, 'a-wrong-action', 'x1', 'pw', a_ops_role));
  perform pg_temp.chk('USR5 a proof minted for another action is refused (UNAUTHORIZED)', r like '%UNAUTHORIZED%', r);

  perform public.election_day_owner_reauth(ob, 'create_permission_user', pg_temp.h('b-proof'));
  r := pg_temp.try_sql(format('select * from public.election_day_create_permission_user_owner_v3(%L, pg_temp.h(%L), %L, %L, %L)', oa, 'b-proof', 'x2', 'pw', a_ops_role));
  perform pg_temp.chk('USR6 Owner A cannot use Owner B''s proof (UNAUTHORIZED)', r like '%UNAUTHORIZED%', r);

  r := pg_temp.try_sql(format('select * from public.election_day_create_permission_user_owner_v3(%L, pg_temp.h(%L), %L, %L, %L)', ob, 'b-proof', 'x3', 'pw', a_mgr_role));
  perform pg_temp.chk('USR7 Owner B cannot create a user with a role of workspace A (ROLE_NOT_FOUND)', r like '%ROLE_NOT_FOUND%', r);

  perform public.election_day_owner_reauth(oa, 'create_permission_user', pg_temp.h('a-dup'));
  r := pg_temp.try_sql(format('select * from public.election_day_create_permission_user_owner_v3(%L, pg_temp.h(%L), %L, %L, %L)', oa, 'a-dup', 'a-manager', 'pw', a_ops_role));
  perform pg_temp.chk('USR8 duplicate name in the same workspace -> 23505', r like '23505%', r);

  perform pg_temp.chk('USR9 each Owner lists only its own workspace',
    (select count(*) from public.election_day_list_permission_users_owner_v3(oa)) = 2
    and (select count(*) from public.election_day_list_permission_users_owner_v3(ob)) = 0, 'isolation');

  r := pg_temp.try_sql(format('select * from public.election_day_list_permission_users_owner_v3(%L)', stranger));
  perform pg_temp.chk('USR10 a non-Owner identity cannot list users (UNAUTHORIZED)', r like '%UNAUTHORIZED%', r);

  perform public.election_day_owner_reauth(oa, 'reset_permission_user_password', pg_temp.h('a-reset-m'));
  r := pg_temp.try_sql(format('select * from public.election_day_reset_permission_user_password_owner_v3(%L, pg_temp.h(%L), %L, %L)', oa, 'a-reset-m', am, 'new-pw'));
  perform pg_temp.chk('USR11 Owner cannot reset a Manager-role user (CANNOT_RESET_MANAGER)', r like '%CANNOT_RESET_MANAGER%', r);

  insert into public.election_day_sessions (permission_user_id, workspace_id, token_hash, expires_at)
  values (ao, wa, pg_temp.h('ao-session'), now() + interval '1 hour');
  perform public.election_day_owner_reauth(oa, 'reset_permission_user_password', pg_temp.h('a-reset-o'));
  perform public.election_day_reset_permission_user_password_owner_v3(oa, pg_temp.h('a-reset-o'), ao, 'ao-new-pw');
  perform pg_temp.chk('USR12 Owner resets an ordinary user: new password verifies, reset_by = Owner, sessions revoked',
    (select extensions.crypt('ao-new-pw', password_hash) = password_hash and reset_by = 'Owner A'
       from public.election_day_permission_users where id = ao)
    and not exists (select 1 from public.election_day_sessions where permission_user_id = ao), 'reset');

  perform public.election_day_owner_reauth(ob, 'reset_permission_user_password', pg_temp.h('b-reset'));
  r := pg_temp.try_sql(format('select * from public.election_day_reset_permission_user_password_owner_v3(%L, pg_temp.h(%L), %L, %L)', ob, 'b-reset', ao, 'hijack'));
  perform pg_temp.chk('USR13 Owner B cannot reset a user of workspace A (USER_NOT_FOUND)', r like '%USER_NOT_FOUND%', r);

  perform public.election_day_owner_reauth(ob, 'delete_permission_user', pg_temp.h('b-del'));
  r := pg_temp.try_sql(format('select public.election_day_delete_permission_user_owner_v3(%L, pg_temp.h(%L), %L)', ob, 'b-del', ao));
  perform pg_temp.chk('USR14 Owner B cannot delete a user of workspace A (USER_NOT_FOUND)', r like '%USER_NOT_FOUND%', r);

  perform public.election_day_owner_reauth(oa, 'delete_permission_user', pg_temp.h('a-del-o'));
  perform public.election_day_delete_permission_user_owner_v3(oa, pg_temp.h('a-del-o'), ao);
  perform public.election_day_owner_reauth(oa, 'delete_permission_user', pg_temp.h('a-del-m'));
  perform public.election_day_delete_permission_user_owner_v3(oa, pg_temp.h('a-del-m'), am);
  perform pg_temp.chk('USR15 Owner deletes an ordinary user AND a Manager', not exists (
    select 1 from public.election_day_permission_users where id in (ao, am)), 'deleted');

  perform pg_temp.chk('USR16 no PermissionUser duplicates an Owner identity; one Owner per workspace',
    not exists (select 1 from public.election_day_permission_users u join public.election_owners o on o.workspace_id = u.workspace_id
                 where lower(u.name) = lower(o.email) or lower(u.name) = lower(o.name))
    and (select max(c) from (select count(*) c from public.election_owners group by workspace_id) x) = 1, 'identity');

  -- ---- entitlement enforcement (workers) ----------------------------------
  insert into public.election_day_permission_users (name, password_hash, role_id, workspace_id)
  values ('d-user', extensions.crypt('pw-d', extensions.gen_salt('bf')), d_ops_role, wd);
  r := pg_temp.try_sql(format('select * from public.election_day_login_v3(%L, %L, %L, pg_temp.h(%L))', code_d, 'd-user', 'pw-d', 'sd1'));
  perform pg_temp.chk('ENF1 valid credentials in a workspace NOT entitled to Election Day -> MODULE_NOT_ENABLED, no session',
    r like '%MODULE_NOT_ENABLED%' and not exists (select 1 from public.election_day_sessions where token_hash = pg_temp.h('sd1')), r);
  r := pg_temp.try_sql(format('select * from public.election_day_login_v3(%L, %L, %L, pg_temp.h(%L))', code_d, 'd-user', 'WRONG', 'sd2'));
  perform pg_temp.chk('ENF2 a WRONG password there is still the generic UNAUTHORIZED (no entitlement oracle)',
    r like '%UNAUTHORIZED%' and r not like '%MODULE_NOT_ENABLED%', r);

  insert into public.election_day_permission_users (name, password_hash, role_id, workspace_id)
  values ('a-user', extensions.crypt('pw-a', extensions.gen_salt('bf')), a_ops_role, wa);
  r := pg_temp.try_sql(format('select * from public.election_day_login_v3(%L, %L, %L, pg_temp.h(%L))', code_a, 'a-user', 'pw-a', 'sa1'));
  perform pg_temp.chk('ENF3 entitled workspace: login succeeds and the session resolves',
    r = 'OK' and (select count(*) from public.election_day_resolve_session(pg_temp.h('sa1'))) = 1, r);

  delete from public.election_workspace_modules where workspace_id = wa and module_key = 'election_day';
  r := pg_temp.try_sql(format('select * from public.election_day_resolve_session(pg_temp.h(%L))', 'sa1'));
  perform pg_temp.chk('ENF4 removing the entitlement kills the EXISTING session on its next call (UNAUTHORIZED)', r like '%UNAUTHORIZED%', r);
  insert into public.election_workspace_modules (workspace_id, module_key) values (wa, 'election_day');
  perform pg_temp.chk('ENF5 restoring the entitlement restores the session',
    (select count(*) from public.election_day_resolve_session(pg_temp.h('sa1'))) = 1, 'restored');

  perform pg_temp.chk('ENF6 owner_has_module: A=election_day yes, D=election_day no, D=budget yes',
    public.election_day_owner_has_module(oa, 'election_day')
    and not public.election_day_owner_has_module(od, 'election_day')
    and public.election_day_owner_has_module(od, 'budget'), 'owner');
  r := pg_temp.try_sql(format('select public.election_day_owner_has_module(%L, %L)', stranger, 'election_day'));
  perform pg_temp.chk('ENF7 owner_has_module for a non-Owner -> UNAUTHORIZED', r like '%UNAUTHORIZED%', r);
  perform pg_temp.chk('ENF8 Owner administration still works in a workspace WITHOUT Election Day',
    (select count(*) from public.election_day_list_permission_users_owner_v3(od)) = 1, 'admin');
  perform pg_temp.chk('ENF9 Owner module read: catalog of 3 with D enabled only for budget',
    (select string_agg(module_key || ':' || enabled, ',' order by sort_order) from public.election_day_list_workspace_modules_owner_v3(od))
      = 'voter_management:false,election_day:false,budget:true', 'modules');

  -- ---- Multi-Entity aggregates vs entitlement ------------------------------
  perform pg_temp.chk('ME1 entitled, active, >= 10 contacts: reported with its counts',
    (select report_status || ':' || contacts_total || ':' || voted from public.multi_entity_get_workspace_aggregate(me, wa)) = 'reported:12:6',
    (select report_status || ':' || coalesce(contacts_total::text, 'null') from public.multi_entity_get_workspace_aggregate(me, wa)));
  perform pg_temp.chk('ME2 NOT entitled (Budget only, 12 contacts): unavailable and EVERY metric null',
    (select report_status = 'unavailable' and contacts_total is null and voted is null and follow_up_closed is null
       and follow_up_remaining is null and ride_needed is null and ride_arranged is null and ride_completed is null
     from public.multi_entity_get_workspace_aggregate(me, wd)), 'unavailable');
  perform pg_temp.chk('ME3 ended + not entitled: still ''ended'' (the existing rule keeps precedence), no numbers',
    (select report_status = 'ended' and contacts_total is null from public.multi_entity_get_workspace_aggregate(me, wf)), 'ended');
  perform pg_temp.chk('ME4 entitled with 0 contacts: still ''suppressed'' (threshold unchanged)',
    (select report_status = 'suppressed' and contacts_total is null from public.multi_entity_get_workspace_aggregate(me, wb)), 'suppressed');
  perform pg_temp.chk('ME5 list: every assigned workspace represented, in name order, with the right status',
    (select string_agg(name || '=' || report_status, ',' order by name) from public.multi_entity_list_workspace_aggregates(me))
      = 'S9 A=reported,S9 B=suppressed,S9 D=unavailable,S9 F=ended',
    (select string_agg(name || '=' || report_status, ',' order by name) from public.multi_entity_list_workspace_aggregates(me)));
  perform pg_temp.chk('ME6 no non-reported row carries any number (no historical/current leakage)',
    not exists (select 1 from public.multi_entity_list_workspace_aggregates(me)
                where report_status <> 'reported' and coalesce(contacts_total, voted, follow_up_closed, follow_up_remaining,
                  ride_needed, ride_arranged, ride_completed) is not null), 'leak');
  -- Each write and each read is its own statement: the aggregate readers are
  -- STABLE, so a read in the SAME statement as a write would see that
  -- statement's starting snapshot, not the write.
  j := public.platform_set_workspace_modules(po, wd, array['budget', 'election_day']);
  r := (select report_status || ':' || contacts_total from public.multi_entity_get_workspace_aggregate(me, wd));
  perform pg_temp.chk('ME7a enabling Election Day releases D''s counts', r = 'reported:12', r);
  j := public.platform_set_workspace_modules(po, wd, array['budget']);
  r := (select report_status || ':' || coalesce(contacts_total::text, 'null') from public.multi_entity_get_workspace_aggregate(me, wd));
  perform pg_temp.chk('ME7b disabling it withdraws them again (unavailable, no numbers)', r = 'unavailable:null', r);
  r := pg_temp.try_sql(format('select * from public.multi_entity_get_workspace_aggregate(%L, %L)', me, gen_random_uuid()));
  perform pg_temp.chk('ME8 assignment semantics unchanged: an unassigned id -> WORKSPACE_NOT_ASSIGNED', r like '%WORKSPACE_NOT_ASSIGNED%', r);
  perform pg_temp.chk('AUD1 the D toggle wrote exactly one enabled + one disabled election_day row, attributed to the Platform Owner',
    pg_temp.audit(wd, 'enabled', 'election_day') = 1 and pg_temp.audit(wd, 'disabled', 'election_day') = 1
    and (select bool_and(acting_platform_owner_auth_user_id = po and acting_auth_user_id = po and workspace_name_snapshot = 'S9 D')
         from public.platform_entitlement_audit where workspace_id_snapshot = wd)
    and (select bool_and(previous_enabled = false and new_enabled) from public.platform_entitlement_audit where workspace_id_snapshot = wd and action = 'enabled')
    and (select bool_and(previous_enabled and not new_enabled) from public.platform_entitlement_audit where workspace_id_snapshot = wd and action = 'disabled'), 'toggle audit');

  -- ---- approval with modules -> provisioning --------------------------------
  select c.pending_id into v_pending from public.platform_create_pending_owner_access(
    po, pend, 'Pending', 'pending@s9.invalid', null, 7, array['election_day', 'budget', 'election_day']) c;
  perform pg_temp.chk('PLT1 approval records the normalized (distinct, sorted) module choice AND its approver',
    (select requested_modules = array['budget', 'election_day'] and approved_by_platform_owner_auth_user_id = po
       from public.election_workspace_pending_owner_access where id = v_pending), 'modules');
  perform pg_temp.chk('AUD2 approval_selected: one row per chosen module, no workspace yet, attributed to the Platform Owner',
    (select count(*) from public.platform_entitlement_audit where pending_access_id_snapshot = v_pending and action = 'approval_selected') = 2
    and (select bool_and(workspace_id_snapshot is null and previous_enabled is null and new_enabled
                         and acting_platform_owner_auth_user_id = po and acting_auth_user_id = po)
         from public.platform_entitlement_audit where pending_access_id_snapshot = v_pending and action = 'approval_selected'), 'approval audit');
  audit_before := (select count(*) from public.platform_entitlement_audit);
  r := pg_temp.try_sql(format('select * from public.platform_create_pending_owner_access(%L, %L, %L, %L, null, 7, array[%L])', po, stranger, 'S', 'stranger@s9.invalid', 'not_a_module'));
  perform pg_temp.chk('PLT2 unknown module -> INVALID_MODULES, no approval row, no audit row',
    r like '%INVALID_MODULES%' and not exists (select 1 from public.election_workspace_pending_owner_access where auth_user_id = stranger)
    and (select count(*) from public.platform_entitlement_audit) = audit_before, r);
  r := pg_temp.try_sql(format('select * from public.platform_create_pending_owner_access(%L, %L, %L, %L, null, 7, %L::text[])', po, stranger, 'S', 'stranger@s9.invalid', '{}'));
  perform pg_temp.chk('PLT3 empty module choice -> INVALID_MODULES', r like '%INVALID_MODULES%', r);
  r := pg_temp.try_sql(format('select * from public.platform_create_pending_owner_access(%L, %L, %L, %L, null, 7, array[%L])', stranger, stranger, 'S', 'stranger@s9.invalid', 'election_day'));
  perform pg_temp.chk('PLT4 a non-Platform-Owner caller -> UNAUTHORIZED', r like '%UNAUTHORIZED%', r);
  r := pg_temp.try_sql('update public.election_workspace_pending_owner_access set approved_by_platform_owner_auth_user_id = null where requested_modules is not null');
  perform pg_temp.chk('PLT5 a module choice can never lose its approver (shape constraint)', r like '23514%', r);

  select (public.election_day_provision_workspace(pend, 'S9 Pending WS', now() + interval '10 days') ->> 'workspace_id')::uuid into v_ws;
  perform pg_temp.chk('PLT6 provisioning copies the approval''s modules into the new workspace, atomically, and consumes it',
    (select array_agg(module_key order by module_key) from public.election_workspace_modules where workspace_id = v_ws) = array['budget', 'election_day']
    and (select status from public.election_workspace_pending_owner_access where id = v_pending) = 'consumed'
    and (select count(*) from public.election_day_permission_users where workspace_id = v_ws) = 0, v_ws::text);
  perform pg_temp.chk('AUD3 provisioning_granted: one row per module, attributed to the APPROVING Platform Owner, executed by the Owner',
    (select count(*) from public.platform_entitlement_audit where workspace_id_snapshot = v_ws and action = 'provisioning_granted') = 2
    and (select bool_and(pending_access_id_snapshot = v_pending and workspace_name_snapshot = 'S9 Pending WS'
                         and acting_platform_owner_auth_user_id = po and acting_auth_user_id = pend
                         and previous_enabled = false and new_enabled)
         from public.platform_entitlement_audit where workspace_id_snapshot = v_ws and action = 'provisioning_granted'), 'grant audit');
  perform pg_temp.chk('PLT7 provisioning retry is idempotent (already_provisioned, one Owner, same modules, no extra audit)',
    (public.election_day_provision_workspace(pend, 'S9 Pending WS', now() + interval '10 days') ->> 'already_provisioned')::boolean
    and (select count(*) from public.election_owners where auth_user_id = pend) = 1
    and (select count(*) from public.election_workspace_modules where workspace_id = v_ws) = 2
    and (select count(*) from public.platform_entitlement_audit where workspace_id_snapshot = v_ws) = 2, 'retry');

  ws_before := (select count(*) from public.election_workspaces);
  audit_before := (select count(*) from public.platform_entitlement_audit);
  r := pg_temp.try_sql(format('select public.election_day_provision_workspace(%L, %L, now() + interval %L)', legacy, 'S9 Legacy WS', '10 days'));
  perform pg_temp.chk('PLT8 a legacy approval WITHOUT a module choice FAILS CLOSED (APPROVAL_MODULES_MISSING)', r like '%APPROVAL_MODULES_MISSING%', r);
  perform pg_temp.chk('PLT9 ... and nothing was created or inferred: no workspace, no Owner, approval still pending, no audit row',
    (select count(*) from public.election_workspaces) = ws_before
    and not exists (select 1 from public.election_owners where auth_user_id = legacy)
    and (select status from public.election_workspace_pending_owner_access where auth_user_id = legacy) = 'pending'
    and (select count(*) from public.platform_entitlement_audit) = audit_before, 'fail closed');

  j := public.platform_list_owner_access(po);
  perform pg_temp.chk('PLT10 the approvals list carries requested_modules (null for the legacy approval)',
    (select e -> 'requested_modules' from jsonb_array_elements(j) e where e ->> 'email' = 'pending@s9.invalid') = '["budget","election_day"]'::jsonb
    and (select e -> 'requested_modules' from jsonb_array_elements(j) e where e ->> 'email' = 'legacy@s9.invalid') = 'null'::jsonb, 'list');

  -- ---- Platform Owner: read / edit entitlements (+ audit) ---------------------
  j := public.platform_list_workspace_modules(po);
  perform pg_temp.chk('PLT11 Platform read: catalog of 3 + every workspace with its modules',
    jsonb_array_length(j -> 'catalog') = 3
    and (select w -> 'modules' from jsonb_array_elements(j -> 'workspaces') w where w ->> 'workspace_id' = wd::text) = '["budget"]'::jsonb, 'read');
  j := public.platform_set_workspace_modules(po, wd, array['election_day', 'voter_management']);
  perform pg_temp.chk('PLT12 set replaces the set exactly and reports what changed',
    (select array_agg(module_key order by module_key) from public.election_workspace_modules where workspace_id = wd)
      = array['election_day', 'voter_management']
    and j -> 'disabled' = '["budget"]'::jsonb and j -> 'enabled' = '["election_day","voter_management"]'::jsonb, j::text);
  perform pg_temp.chk('AUD4 that edit wrote exactly: disabled budget, enabled election_day, enabled voter_management',
    pg_temp.audit(wd, 'disabled', 'budget') = 1 and pg_temp.audit(wd, 'enabled', 'election_day') = 2
    and pg_temp.audit(wd, 'enabled', 'voter_management') = 1, 'edit audit');
  audit_before := (select count(*) from public.platform_entitlement_audit);
  j := public.platform_set_workspace_modules(po, wd, array['voter_management', 'election_day']);
  perform pg_temp.chk('AUD5 a no-op edit (same set) changes nothing and writes NO audit row',
    (select count(*) from public.platform_entitlement_audit) = audit_before and j -> 'enabled' = '[]'::jsonb and j -> 'disabled' = '[]'::jsonb, j::text);
  r := pg_temp.try_sql(format('select public.platform_set_workspace_modules(%L, %L, %L::text[])', po, wd, '{}'));
  perform pg_temp.chk('PLT13 set with an empty list -> INVALID_MODULES (unchanged, no audit)',
    r like '%INVALID_MODULES%' and (select count(*) from public.election_workspace_modules where workspace_id = wd) = 2
    and (select count(*) from public.platform_entitlement_audit) = audit_before, r);
  r := pg_temp.try_sql(format('select public.platform_set_workspace_modules(%L, %L, array[%L])', po, wd, 'nope'));
  perform pg_temp.chk('PLT14 set with an unknown module -> INVALID_MODULES (unchanged, no audit)',
    r like '%INVALID_MODULES%' and (select count(*) from public.platform_entitlement_audit) = audit_before, r);
  r := pg_temp.try_sql(format('select public.platform_set_workspace_modules(%L, %L, array[%L])', po, gen_random_uuid(), 'election_day'));
  perform pg_temp.chk('PLT15 set for a nonexistent workspace -> WORKSPACE_NOT_FOUND', r like '%WORKSPACE_NOT_FOUND%', r);
  r := pg_temp.try_sql(format('select public.platform_set_workspace_modules(%L, %L, array[%L])', oa, wa, 'budget'));
  perform pg_temp.chk('PLT16 an Election Owner cannot edit entitlements (UNAUTHORIZED, no audit)',
    r like '%UNAUTHORIZED%' and (select count(*) from public.platform_entitlement_audit) = audit_before, r);

  -- ---- audit: atomicity + immutability ----------------------------------------
  execute 'create function public.s9_audit_fail() returns trigger language plpgsql as $f$ begin raise exception ''S9_AUDIT_FAIL''; end $f$';
  execute 'create trigger s9_audit_fail before insert on public.platform_entitlement_audit for each row when (new.module_key = ''budget'') execute function public.s9_audit_fail()';
  r := pg_temp.try_sql(format('select public.platform_set_workspace_modules(%L, %L, array[%L, %L])', po, wa, 'election_day', 'budget'));
  perform pg_temp.chk('AUD6 if the audit write fails, the entitlement change is rolled back with it (no partial change)',
    r like '%S9_AUDIT_FAIL%'
    and (select array_agg(module_key) from public.election_workspace_modules where workspace_id = wa) = array['election_day']
    and pg_temp.audit(wa, 'enabled', 'budget') = 0, r);
  execute 'drop trigger s9_audit_fail on public.platform_entitlement_audit';
  execute 'drop function public.s9_audit_fail()';

  r := pg_temp.try_sql('update public.platform_entitlement_audit set module_key = ''tampered''');
  perform pg_temp.chk('AUD7 UPDATE on the audit is refused (AUDIT_IMMUTABLE)', r like '%AUDIT_IMMUTABLE%', r);
  r := pg_temp.try_sql('delete from public.platform_entitlement_audit');
  perform pg_temp.chk('AUD8 DELETE on the audit is refused (AUDIT_IMMUTABLE)', r like '%AUDIT_IMMUTABLE%', r);
  r := pg_temp.try_sql('truncate public.platform_entitlement_audit');
  perform pg_temp.chk('AUD9 TRUNCATE on the audit is refused (AUDIT_IMMUTABLE)', r like '%AUDIT_IMMUTABLE%', r);
  r := pg_temp.try_sql('insert into public.platform_entitlement_audit (action, module_key, new_enabled, acting_platform_owner_auth_user_id, acting_auth_user_id) values (''enabled'', ''budget'', true, gen_random_uuid(), gen_random_uuid())');
  perform pg_temp.chk('AUD10 a malformed row (enable without workspace/previous state) is refused by the shape constraints', r like '23514%', r);

  -- ---- roles: is_manager surface --------------------------------------------
  perform pg_temp.chk('ROL1 Owner role read carries is_manager',
    (select is_manager from public.election_day_list_roles_owner_v3(oa) where id = a_mgr_role)
    and not (select is_manager from public.election_day_list_roles_owner_v3(oa) where id = a_ops_role), 'read');
  perform public.election_day_owner_reauth(oa, 'create_role', pg_temp.h('a-role-c'));
  select x.id into v_role from public.election_day_create_role_owner_v3(oa, pg_temp.h('a-role-c'), 'S9 Area Manager', '', array['voter.viewName'], 'all', true) x;
  perform pg_temp.chk('ROL2 create with p_is_manager=true', (select is_manager from public.election_day_roles where id = v_role), v_role::text);
  perform public.election_day_owner_reauth(oa, 'update_role', pg_temp.h('a-role-u1'));
  perform public.election_day_update_role_owner_v3(oa, pg_temp.h('a-role-u1'), v_role, 'S9 Area Manager', '', array['electionDay.import'], 'all');
  perform pg_temp.chk('ROL3 a permission change (original overload) leaves is_manager unchanged', (select is_manager from public.election_day_roles where id = v_role), 'kept');
  perform public.election_day_owner_reauth(oa, 'update_role', pg_temp.h('a-role-u2'));
  perform public.election_day_update_role_owner_v3(oa, pg_temp.h('a-role-u2'), v_role, 'S9 Area Manager', '', array['electionDay.import'], 'all', false);
  perform pg_temp.chk('ROL4 only an explicit p_is_manager=false clears it (admin permissions do not keep it set)', not (select is_manager from public.election_day_roles where id = v_role), 'cleared');
  perform public.election_day_owner_reauth(oa, 'clone_role', pg_temp.h('a-role-clone'));
  select x.id into v_role from public.election_day_clone_role_owner_v3(oa, pg_temp.h('a-role-clone'), a_mgr_role, 'S9 Manager Copy') x;
  perform pg_temp.chk('ROL5 clone inherits is_manager', (select is_manager from public.election_day_roles where id = v_role), v_role::text);
end $$;

select id, ok, detail from _r order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from _r;

do $$
declare f int := (select count(*) from _r where not ok);
begin
  if f > 0 then
    raise exception 'STAGE 9 DB SUITE: % FAILED', f;
  end if;
end $$;

rollback;
