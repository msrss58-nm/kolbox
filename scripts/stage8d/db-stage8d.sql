-- Platform Stage 8D - DATABASE suite: security remediation for H-1 and H-2
-- (migration 20260915000000). Asserts the SECURE post-fix state as PASS:
-- H-1 the 4 legacy reason RPCs lose anon/authenticated EXECUTE (and are refused
-- when called as those roles) while the trusted _v3/_core path is unchanged;
-- H-2 the legacy election_day_settings singleton is no longer anon/authenticated
-- readable or writable and its permissive policy is gone, RLS still on, the
-- per-workspace table stays denied, and the DEFINER reverse-sync mirror still
-- keeps the singleton current for a trusted write; plus catalog/ACL for the two
-- new H-3 functions and the unchanged provision signature.
--
-- Run ONLY against the isolated scratch stack (scripts/stage5/mkScratchStack.mjs):
--   docker exec -i supabase_db_kolboxs5 psql -U postgres -v ON_ERROR_STOP=1 < scripts/stage8d/db-stage8d.sql
--
-- ONE transaction, ROLLED BACK at the end. Synthetic ids only. Non-zero exit on any fail.

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
  reset role;
  return sqlstate;
end $$;

-- Fixtures
delete from public.multi_entity_assignments;
delete from public.multi_entity_owner;
delete from public.election_owners;
delete from public.election_workspace_pending_owner_access;
delete from public.platform_owners;

insert into public.election_workspaces (id, name, election_end_at, login_code) values
  ('8d000000-0000-4000-8000-0000000000a1', 'S8D WS A', now() + interval '10 days', public.election_day_generate_workspace_login_code()),
  ('8d000000-0000-4000-8000-0000000000b2', 'S8D WS B', now() + interval '10 days', public.election_day_generate_workspace_login_code());
select public.election_day_seed_new_workspace('8d000000-0000-4000-8000-0000000000a1');
select public.election_day_seed_new_workspace('8d000000-0000-4000-8000-0000000000b2');

do $$
declare
  h1 constant text[] := array[
    'election_day_list_non_voting_reasons()',
    'election_day_set_non_voting_reason_active(p_id uuid, p_is_active boolean)',
    'election_day_delete_non_voting_reason(p_id uuid)',
    'election_day_reorder_non_voting_reasons(p_ordered_ids uuid[])'];
  new_fns constant text[] := array[
    'election_day_invalidate_owner_recovery(p_auth_user_id uuid)',
    'platform_reissue_finalize(p_platform_owner_auth_user_id uuid, p_pending_id uuid)'];
  a_reason uuid;
  b_reason_before int;
  mirror_before timestamptz;
  mirror_after timestamptz;
begin
  -- ===================== H-1 =====================
  perform pg_temp.chk('H1-C1 all 4 legacy reason RPCs: anon+authenticated EXECUTE REVOKED',
    (select bool_and(not has_function_privilege('anon', p.oid, 'EXECUTE')
                 and not has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')') = any(h1)),
    'has_function_privilege');
  perform pg_temp.chk('H1-C2 exactly 4 matched (signatures intact, not dropped/renamed)',
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public' and (p.proname||'('||pg_get_function_identity_arguments(p.oid)||')') = any(h1)) = 4, 'count');
  perform pg_temp.chk('H1-R1 anon call of list -> 42501',
    pg_temp.try_as('anon', 'select public.election_day_list_non_voting_reasons()') = '42501', 'anon list');
  perform pg_temp.chk('H1-R2 authenticated call of list -> 42501',
    pg_temp.try_as('authenticated', 'select public.election_day_list_non_voting_reasons()') = '42501', 'authn list');
  select id into a_reason from public.election_day_not_voting_reasons where workspace_id='8d000000-0000-4000-8000-0000000000a1' order by sort_order limit 1;
  perform pg_temp.chk('H1-R3 anon delete -> 42501, reason survives',
    pg_temp.try_as('anon', format('select public.election_day_delete_non_voting_reason(%L)', a_reason)) = '42501'
    and exists (select 1 from public.election_day_not_voting_reasons where id = a_reason), 'anon delete');
  perform pg_temp.chk('H1-R4 anon set_active -> 42501; authenticated reorder -> 42501',
    pg_temp.try_as('anon', format('select public.election_day_set_non_voting_reason_active(%L, false)', a_reason)) = '42501'
    and pg_temp.try_as('authenticated', format('select public.election_day_reorder_non_voting_reasons(array[%L]::uuid[])', a_reason)) = '42501', 'mutations');
  -- Trusted path unchanged: the _core mutator still works (called as owner here,
  -- standing in for the _v3 wrapper), proving remediation touched only the legacy fns.
  b_reason_before := (select count(*) from public.election_day_not_voting_reasons where workspace_id='8d000000-0000-4000-8000-0000000000b2');
  perform public.election_day_delete_non_voting_reason_core('8d000000-0000-4000-8000-0000000000b2',
    (select id from public.election_day_not_voting_reasons r where r.workspace_id='8d000000-0000-4000-8000-0000000000b2'
      and not exists (select 1 from public.election_day_voters v where v.not_voting_reason_id=r.id) order by sort_order desc limit 1));
  perform pg_temp.chk('H1-T1 trusted _core reason delete still works (workspace-scoped)',
    (select count(*) from public.election_day_not_voting_reasons where workspace_id='8d000000-0000-4000-8000-0000000000b2') = b_reason_before - 1, 'core delete');
  perform pg_temp.chk('H1-T2 trusted _core is service_role-only (unchanged by 8D)',
    (select not has_function_privilege('anon', p.oid, 'EXECUTE') and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
       and p.proname='election_day_delete_non_voting_reason_core'), 'core acl');

  -- ===================== H-2 =====================
  perform pg_temp.chk('H2-C1 permissive policy election_day_settings_all is DROPPED',
    not exists (select 1 from pg_policies where schemaname='public' and tablename='election_day_settings' and policyname='election_day_settings_all'), 'policy');
  perform pg_temp.chk('H2-C2 RLS still ENABLED on the singleton',
    (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='election_day_settings'), 'rls');
  perform pg_temp.chk('H2-C3 anon+authenticated have NO table privilege on the singleton',
    not has_table_privilege('anon','public.election_day_settings','UPDATE')
    and not has_table_privilege('anon','public.election_day_settings','INSERT')
    and not has_table_privilege('anon','public.election_day_settings','SELECT')
    and not has_table_privilege('authenticated','public.election_day_settings','UPDATE'), 'grants');
  perform pg_temp.chk('H2-R1 anon UPDATE of the singleton -> 42501',
    pg_temp.try_as('anon', format('update public.election_day_settings set workspace_id=%L, deadline=now() where id=true', '8d000000-0000-4000-8000-0000000000a1')) = '42501', 'anon update');
  perform pg_temp.chk('H2-R2 anon INSERT into the singleton -> 42501',
    pg_temp.try_as('anon', 'insert into public.election_day_settings (id, deadline) values (true, now())') = '42501', 'anon insert');
  perform pg_temp.chk('H2-R3 authenticated UPDATE of the singleton -> 42501',
    pg_temp.try_as('authenticated', 'update public.election_day_settings set deadline=now() where id=true') = '42501', 'authn update');
  perform pg_temp.chk('H2-R4 per-workspace table still denies anon SELECT (0 rows / no privilege)',
    not has_table_privilege('anon','public.election_day_workspace_settings','SELECT')
    or pg_temp.try_as('anon','select * from public.election_day_workspace_settings') in ('42501','OK'), 'ws table');
  -- Reverse mirror still works: a trusted write to the per-workspace table (as
  -- postgres, standing in for the DEFINER _core) fires the DEFINER sync trigger
  -- that updates the singleton, proving H-2 remediation did not break rollback safety.
  update public.election_day_settings set workspace_id='8d000000-0000-4000-8000-0000000000a1' where id=true;
  insert into public.election_day_workspace_settings (workspace_id, deadline)
    values ('8d000000-0000-4000-8000-0000000000a1', '2031-01-01T00:00:00Z')
    on conflict (workspace_id) do update set deadline=excluded.deadline;
  mirror_before := (select deadline from public.election_day_settings where id=true);
  update public.election_day_workspace_settings set deadline='2032-02-02T00:00:00Z' where workspace_id='8d000000-0000-4000-8000-0000000000a1';
  mirror_after := (select deadline from public.election_day_settings where id=true);
  perform pg_temp.chk('H2-M1 DEFINER reverse-sync mirror still updates the singleton (rollback safety intact)',
    mirror_before = '2031-01-01T00:00:00+00'::timestamptz and mirror_after = '2032-02-02T00:00:00+00'::timestamptz,
    'before=' || mirror_before::text || ' after=' || mirror_after::text);

  -- ===================== H-3 catalog =====================
  perform pg_temp.chk('H3-C1 both new fns: SECURITY DEFINER, search_path empty, owned by postgres',
    (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and (p.proname||'('||pg_get_function_identity_arguments(p.oid)||')') = any(new_fns)
       and p.prosecdef and array_to_string(p.proconfig,',')='search_path=""' and pg_get_userbyid(p.proowner)='postgres') = 2, 'defs');
  perform pg_temp.chk('H3-C2 both new fns: no anon/authenticated EXECUTE, service_role granted',
    (select bool_and(not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')
                 and has_function_privilege('service_role',p.oid,'EXECUTE'))
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
       and (p.proname||'('||pg_get_function_identity_arguments(p.oid)||')') = any(new_fns)), 'acl');
  perform pg_temp.chk('H3-C3 anon cannot call the invalidator (42501)',
    pg_temp.try_as('anon', format('select public.election_day_invalidate_owner_recovery(%L)', gen_random_uuid())) = '42501', 'anon invalidator');
  perform pg_temp.chk('H3-C4 provision fn signature intact and now calls the invalidator',
    exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and p.proname='election_day_provision_workspace'
              and pg_get_function_identity_arguments(p.oid)='p_auth_user_id uuid, p_workspace_name text, p_election_end_at timestamp with time zone'
              and p.prosrc ilike '%election_day_invalidate_owner_recovery%'), 'provision body');
end $$;

select n, case when ok then 'PASS' else '**FAIL**' end as result, id, detail from _r order by n;
select count(*) filter (where ok) as pass, count(*) filter (where not ok) as fail, count(*) as total from _r;
do $$
declare f int := (select count(*) from _r where not ok);
begin
  if f > 0 then raise exception 'STAGE8D_DB_SUITE_FAILED: % assertion(s) failed', f; end if;
end $$;
rollback;
